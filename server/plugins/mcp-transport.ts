import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { pluginHost } from './host.js';
import type { createAuth } from '../auth.js';
import type { AppDatabase } from '../db.js';
import type { HostConfig } from '../../shared/platform-contracts.js';
import type { Principal } from '../../shared/knowledge-contracts.js';
import { verifyMcpBearer, mcpPolicy } from '../platform/oauth.js';
import { oauthGrantStore } from '../platform/oauth-grants.js';
import { remoteAuthGeneration } from '../platform/remote-auth.js';
import { currentPrincipalPolicy } from '../agent/config.js';
import { checkTokenCutoff } from '../agent/auth.js';
import { fail } from '../knowledge/errors.js';
import type { platformRuntime } from '../platform/runtime.js';
type Host = ReturnType<typeof pluginHost>;
export function mcpTransports(app: FastifyInstance, host: Host, auth: Awaited<ReturnType<typeof createAuth>>, config: HostConfig, db: AppDatabase, platform: ReturnType<typeof platformRuntime>) {
  let compat: FastifyInstance | undefined, compatPort: number | undefined, compatError: string | undefined;
  function available(mode: 'oauth' | 'tunnel') {
    const item = host.list().find(p => p.id==='mcp');
    return item?.state === 'enabled' && (item.config.mode === mode || item.config.mode === 'both');
  }
  function staticPrincipal(authorization: unknown): Principal {
    const values=host.privateConfig('mcp'), info=host.secretInfo('mcp','tunnelToken');
    const supplied=typeof authorization==='string' && authorization.startsWith('Bearer ') ? Buffer.from(authorization.slice(7)) : Buffer.alloc(0);
    const expected=Buffer.from(values.tunnelToken || '');
    if (!expected.length || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)
      || !info?.createdAt || info.authGeneration!==remoteAuthGeneration(db)) fail(401,'UNAUTHORIZED');
    const owner=(db.prepare('SELECT id FROM user LIMIT 1').get() as any)?.id; if (!owner) fail(401,'UNAUTHORIZED');
    // Reference identity survives unrelated config updates/restarts. A revoked row
    // is never recreated on first use; only actual credential rotation changes it.
    const clientId='tunnel:'+info.reference, grants=oauthGrantStore(db);
    let reference=grants.activeReference(owner,clientId);
    if (!reference) {
      const previous=db.prepare('SELECT 1 FROM platform_grants WHERE owner_id=? AND client_id=?').get(owner,clientId);
      if (previous) fail(401,'UNAUTHORIZED');
      const policy=mcpPolicy(db);
      reference=grants.approve(owner,clientId,['knowledge:read',...(!policy.readOnly?['knowledge:write']:[]),...(policy.allowIndex?['knowledge:index']:[])],policy.allowedPrefixes).reference;
    }
    const grant=grants.requireExact(reference,owner,clientId,[]);
    return {id:owner,clientId,scopes:grant.scopes,allowedPrefixes:grant.allowedPrefixes,
      tokenIssuedAt:Math.max(Math.floor(info.createdAt/1000),grant.notBefore),grantId:grant.id,grantVersion:grant.version,pluginId:'mcp',authGeneration:info.authGeneration};
  }
  function register(server: FastifyInstance, mode: 'oauth' | 'tunnel') {
    server.route({ method:['POST','GET','DELETE','OPTIONS'],url:'/mcp',bodyLimit:128*1024,handler:handle });
    if(mode==='tunnel') {
      server.get('/health',async()=>({status:available('tunnel')?'ok':'disabled'}));
      server.get('/openapi.json',handle);
      server.post('/api/v1/tools/:tool',{bodyLimit:128*1024},handle);
    }
    async function handle(req: any,reply: any) {
      const path=new URL(req.url,'http://local.invalid');
      try {
        if(!available(mode)) fail(404,'PLUGIN_PROTOCOL_UNAVAILABLE');
        if(req.headers['content-encoding']) fail(415,'COMPRESSED_REQUEST_NOT_ALLOWED');
        if(path.searchParams.has('access_token')) fail(401,'UNAUTHORIZED');
        const allowedHosts=new Set([new URL(config.origin).host,'localhost:'+compatPort,'127.0.0.1:'+compatPort]);
        if(mode==='tunnel' && host.privateConfig('mcp').tunnelOrigin) allowedHosts.add(new URL(host.privateConfig('mcp').tunnelOrigin).host);
        if(!allowedHosts.has(req.headers.host)) fail(403,'FORBIDDEN');
        const origin=req.headers.origin;
        if(origin && origin!==config.origin) fail(403,'FORBIDDEN');
        if(origin) reply.header('Access-Control-Allow-Origin',origin).header('Vary','Origin').header('Access-Control-Expose-Headers','WWW-Authenticate,MCP-Protocol-Version');
        if(req.method==='OPTIONS') {
          if(req.headers['access-control-request-method'] && req.headers['access-control-request-method']!=='POST') fail(403,'FORBIDDEN');
          const headers=['authorization','content-type','mcp-protocol-version','mcp-session-id','last-event-id'];
          if(String(req.headers['access-control-request-headers']||'').split(',').map((h:string)=>h.trim().toLowerCase()).filter(Boolean).some((h:string)=>!headers.includes(h))) fail(403,'FORBIDDEN');
          return reply.header('Access-Control-Allow-Methods','POST').header('Access-Control-Allow-Headers',headers.join(',')).code(204).send();
        }
        // The legacy document contains no private material. Keep it discoverable.
        const document=mode==='tunnel' && path.pathname==='/openapi.json';
        const principal=document ? undefined : mode==='oauth' ? {...await verifyMcpBearer(auth,config,db,req.headers.authorization),pluginId:'mcp'} : staticPrincipal(req.headers.authorization);
        if(principal) {
          checkTokenCutoff(db,principal);
          const runtime=platform.get(); const policy=currentPrincipalPolicy(runtime.config,db,principal);
          if(!policy) fail(401,'UNAUTHORIZED');
          principal.scopes=principal.scopes.filter(s=>policy.scopes.includes(s)); principal.allowedPrefixes=policy.allowedPrefixes;
        }
        if(path.pathname==='/mcp' && req.method!=='POST') return reply.code(405).header('Allow','POST').send({jsonrpc:'2.0',id:null,error:{code:-32000,message:'POST required'}});
        for(const [key,value] of Object.entries(reply.getHeaders())) if(value!==undefined) reply.raw.setHeader(key,value as any);
        reply.hijack();
        await host.protocol('mcp','mcp.'+(mode==='oauth'?'oauth':'compat'),{request:req.raw,response:reply.raw,body:req.body,
          call:{ownerId:principal?.id || '',principal,channel:'mcp',input:{},services:undefined as any}});
        return reply;
      } catch(e) {
        const error=e as any, status=error.statusCode || error.status || 500;
        const code=typeof error.code==='string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:'INTERNAL_ERROR';
        if(!reply.raw.headersSent) {
          const headers: Record<string,string>={'content-type':'application/json','cache-control':'no-store'};
          if(status===401) headers['www-authenticate']=mode==='oauth' ? `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp"` : 'Bearer realm="DooKnow Tunnel"';
          if(status===403 && ['knowledge:read','knowledge:write','knowledge:index'].includes(error.requiredScope)) headers['www-authenticate']=`Bearer error="insufficient_scope", scope="${error.requiredScope}"`;
          const details={code,message:code,retryable:!!error.retryable,...(typeof error.requestId==='string' && error.requestId.length<=128 ? {requestId:error.requestId}: {})};
          const b=req.body, id=(typeof b?.id==='number' && Number.isFinite(b.id)) || (typeof b?.id==='string' && Buffer.byteLength(b.id)<=128)?b.id:null;
          reply.raw.writeHead(status,headers).end(JSON.stringify(path.pathname==='/mcp'?{jsonrpc:'2.0',id,error:{code:status===401?-32001:-32600,message:code,data:details}}:{error:details}));
          reply.hijack();
        } else if(!reply.raw.writableEnded) reply.raw.end();
        return reply;
      }
    }
  }
  register(app,'oauth');
  async function reconcile() {
    const p=host.list().find(p=>p.id==='mcp'), port=p?.config.compatPort as number | undefined;
    if(compat && (!available('tunnel') || port!==compatPort)) { const previous=compat;compat=undefined;compatPort=undefined;await previous.close(); }
    if(!compat && available('tunnel')) {
      const server=Fastify({logger:false,bodyLimit:128*1024}); compatPort=port || 3071;
      register(server,'tunnel');
      try { await server.listen({host:'127.0.0.1',port:compatPort});compat=server;compatError=undefined;host.dependencyError('mcp'); }
      catch { await server.close();compatPort=undefined;compatError='TUNNEL_PORT_UNAVAILABLE';host.dependencyError('mcp',compatError); }
    }
  }
  const unsubscribe=host.onChange(reconcile);
  return { start:reconcile, close:async()=>{unsubscribe();if(compat){const previous=compat;compat=undefined;await previous.close();}},
    connection:async()=>({oauth:{ready:available('oauth') && config.origin.startsWith('https:') && platform.status().components.knowledge,
      address:config.origin+'/mcp',reason:!available('oauth')?'OAuth 连接方式未启用':!config.origin.startsWith('https:')?'需要浏览器可达的 HTTPS 授权站点和 MCP 地址':!platform.status().components.knowledge?'知识库尚未就绪':undefined},
      tunnel:{ready:!!compat && !!host.secretInfo('mcp','tunnelToken') && host.secretInfo('mcp','tunnelToken')!.authGeneration===remoteAuthGeneration(db),
        address:compatPort?(host.privateConfig('mcp').tunnelOrigin || 'http://127.0.0.1:'+compatPort)+'/mcp':undefined,reason:compatError || (!available('tunnel')?'Tunnel 连接方式未启用':'需要有效的独立 Tunnel 密钥')}}) };
}

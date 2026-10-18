import {expect,it} from 'vitest';
import {collectAccount} from '../scripts/account-prompt.js';
it('retries each invalid field and mismatched passwords without discarding the valid username',async()=>{
 const users=['!','owner'];const passwords=['short','long-enough-password','different-password','final-valid-password','final-valid-password'];const errors:string[]=[];
 const result=await collectAccount({username:async()=>users.shift()!,password:async()=>passwords.shift()!,report:s=>errors.push(s)});
 expect(result).toEqual({username:'owner',password:'final-valid-password'});expect(users).toHaveLength(0);expect(passwords).toHaveLength(0);expect(errors).toHaveLength(3);
 expect(errors.join(' ')).not.toContain('short');expect(errors.join(' ')).not.toContain('different-password');
});
it('reset skips username and retries short passwords',async()=>{
 const passwords=['bad','valid-reset-password','valid-reset-password'];
 expect(await collectAccount({username:async()=>{throw Error('unexpected username');},password:async()=>passwords.shift()!,report:()=>{}},true)).toEqual({username:'',password:'valid-reset-password'});
});
it('propagates terminal cancellation rather than retrying forever',async()=>{
 await expect(collectAccount({username:async()=>{throw Error('cancelled');},password:async()=>'',report:()=>{}})).rejects.toThrow('cancelled');
});

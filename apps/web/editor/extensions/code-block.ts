import {createApp} from 'vue';
import CodeBlock from '@tiptap/extension-code-block';
export const DocumentCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({node,editor}) => {
      const language=node.attrs.language;
      const diagram=['mermaid','excalidraw'].includes(language);
      const dom=document.createElement(diagram?'div':'pre');
      if(!diagram){const code=document.createElement('code');dom.append(code);return {dom,contentDOM:code};}
      dom.contentEditable='false';dom.className='document-diagram';
      let app:ReturnType<typeof createApp>|undefined,alive=true;
      void import('../../components/DiagramPreview.vue').then(({default:DiagramPreview})=>{
        if(!alive)return;
        app=createApp(DiagramPreview,{kind:language,code:node.textContent,
          noteId:(editor.options.editorProps.attributes as Record<string,string>)?.['data-note-id']});
        app.mount(dom);
      });
      return {dom,stopEvent:()=>true,ignoreMutation:()=>true,
        update(next){return next.type===node.type&&next.attrs.language===language&&next.textContent===node.textContent;},
        destroy(){alive=false;app?.unmount();}};
    };
  },
  renderMarkdown(node) {
    const language = node.attrs?.language || '';
    if (!/^[a-zA-Z0-9_+#.-]*$/.test(language)) throw Error('代码语言包含无法安全保存的字符');
    const body = (node.content || []).map((x) => x.text || '').join('');
    let width = 3;
    for (const match of body.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
    const fence = '`'.repeat(width);
    return `${fence}${language}\n${body}\n${fence}`;
  },
});

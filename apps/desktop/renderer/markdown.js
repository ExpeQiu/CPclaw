// 仅以 DOM 节点渲染 Markdown；原始 HTML 不解析，模型内容不能执行脚本。
function appendChatInline(root,text,streaming=false){
  const tokens=/(`+)([^`]*?)\1|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let offset=0;
  const plain=value=>root.append(document.createTextNode(value.replace(/\*\*|__|~~/g,'').replace(streaming?/[\*`]$/:/$^/,'')));
  for(const match of text.matchAll(tokens)){
    plain(text.slice(offset,match.index));
    const tag=match[1]?'code':match[3]||match[4]?'strong':match[5]?'del':match[6]||match[7]?'em':'span';
    const element=document.createElement(tag);
    const value=match[2]??match[3]??match[4]??match[5]??match[6]??match[7]??match[8];
    if(tag==='code')element.textContent=value;else appendChatInline(element,value,streaming);
    if(match[8]){element.className='markdown-link-label';element.title=match[9];}
    root.append(element);offset=match.index+match[0].length;
  }
  plain(text.slice(offset));
}
function markdownCells(line){
  const text=line.trim().replace(/^\|/,'').replace(/(?<!\\)\|$/,'');const result=[];let part='',code=false;
  for(let i=0;i<text.length;i++){const char=text[i];if(char==='\\'&&text[i+1]==='|'){part+='|';i++;continue;}if(char==='`')code=!code;if(char==='|'&&!code){result.push(part.trim());part='';}else part+=char;}
  result.push(part.trim());return result;
}
function buildChatMarkdown(source,streaming=false){
  const root=document.createDocumentFragment(),lines=source.replace(/\r\n?/g,'\n').split('\n');let index=0;
  const cells=markdownCells;
  const tableSeparator=at=>{let next=at+1;while(next<lines.length&&!lines[next].trim())next++;return lines[at].includes('|')&&cells(lines[at]).length>=2&&next<lines.length&&cells(lines[next]).length===cells(lines[at]).length&&cells(lines[next]).every(c=>/^:?-+:?$/.test(c))?next:-1;};
  const special=line=>/^\s*(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|```|~~~|(?:[-*_]\s*){3,}$)/.test(line);
  while(index<lines.length){
    const line=lines[index];if(!line.trim()){index++;continue;}
    const fence=line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if(fence){index++;const code=document.createElement('code'),pre=document.createElement('pre'),body=[];while(index<lines.length&&!lines[index].trim().startsWith(fence[1]))body.push(lines[index++]);if(index<lines.length)index++;code.textContent=body.join('\n');pre.append(code);root.append(pre);continue;}
    const heading=line.match(/^\s*(#{1,6})(?:\s+|$)(.*)$/);
    if(heading){const h=document.createElement('h'+heading[1].length);appendChatInline(h,heading[2].replace(/\s+#+\s*$/,''),streaming);root.append(h);index++;continue;}
    if(/^\s*(?:[-*_]\s*){3,}$/.test(line)){root.append(document.createElement('hr'));index++;continue;}
    if(/^\s*>/.test(line)){const quote=document.createElement('blockquote'),body=[];while(index<lines.length&&/^\s*>/.test(lines[index]))body.push(lines[index++].replace(/^\s*>\s?/,''));quote.append(buildChatMarkdown(body.join('\n'),streaming));root.append(quote);continue;}
    const separator=tableSeparator(index);
    if(separator>=0){
      const wrap=document.createElement('div'),table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');wrap.className='markdown-table';
      const headings=cells(line),align=cells(lines[separator]).map(c=>c.startsWith(':')&&c.endsWith(':')?'center':c.endsWith(':')?'right':'left');
      headings.forEach((value,i)=>{const th=document.createElement('th');th.style.textAlign=align[i];appendChatInline(th,value,streaming);tr.append(th);});head.append(tr);table.append(head);index=separator+1;
      const body=document.createElement('tbody');
      while(index<lines.length){let rowIndex=index;while(rowIndex<lines.length&&!lines[rowIndex].trim())rowIndex++;
        if(rowIndex>=lines.length||!lines[rowIndex].trim().startsWith('|')&&!lines[rowIndex].includes('|'))break;
        const values=cells(lines[rowIndex]);if(values.length<2)break;
        const row=document.createElement('tr');headings.forEach((_,i)=>{const td=document.createElement('td');td.style.textAlign=align[i];appendChatInline(td,values[i]??'',streaming);row.append(td);});body.append(row);index=rowIndex+1;
      }
      table.append(body);wrap.append(table);root.append(wrap);continue;
    }
    if(index+1<lines.length&&/^\s*(?:=+|-+)\s*$/.test(lines[index+1])){const heading=document.createElement(lines[index+1].trim()[0]==='='?'h1':'h2');appendChatInline(heading,line,streaming);root.append(heading);index+=2;continue;}
    const item=line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if(item){const list=document.createElement(item[3]?'ol':'ul');if(item[3]&&item[3]!=='1')list.setAttribute('start',item[3]);
      while(index<lines.length){const next=lines[index].match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);if(!next||Boolean(next[3])!==Boolean(item[3])||next[1].length!==item[1].length)break;index++;
        const li=document.createElement('li');const task=next[4].match(/^\[([ xX])\]\s+(.*)$/);if(task){const box=document.createElement('input');box.type='checkbox';box.disabled=true;box.checked=task[1].toLowerCase()==='x';li.append(box);appendChatInline(li,task[2],streaming);}else appendChatInline(li,next[4],streaming);const nested=[];
        while(index<lines.length&&lines[index].trim()&&/^\s+/.test(lines[index])&&lines[index].match(/^\s*/)[0].length>item[1].length)nested.push(lines[index++].slice(item[1].length+2));
        if(nested.length)li.append(buildChatMarkdown(nested.join('\n'),streaming));list.append(li);
      }root.append(list);continue;
    }
    const paragraph=[line];index++;
    while(index<lines.length&&lines[index].trim()&&!special(lines[index])&&tableSeparator(index)<0)paragraph.push(lines[index++]);
    const p=document.createElement('p');appendChatInline(p,paragraph.join('\n'),streaming);root.append(p);
  }
  return root;
}
function reconcileMarkdown(root,next){
  const desired=[...next.childNodes];
  desired.forEach((node,index)=>{const existing=root.childNodes[index];
    if(!existing){root.append(node);return;}
    if(existing.nodeType!==node.nodeType||existing.nodeName!==node.nodeName){existing.replaceWith(node);return;}
    if(node.nodeType===Node.TEXT_NODE){if(existing.nodeValue!==node.nodeValue)existing.nodeValue=node.nodeValue;return;}
    for(const attr of [...existing.attributes])if(!node.hasAttribute(attr.name))existing.removeAttribute(attr.name);
    for(const attr of node.attributes)if(existing.getAttribute(attr.name)!==attr.value)existing.setAttribute(attr.name,attr.value);
    reconcileMarkdown(existing,node);
  });
  while(root.childNodes.length>desired.length)root.lastChild.remove();
}
function renderChatMarkdown(root,text,streaming=false){
  if(root.dataset.markdown===text&&root.dataset.streaming===String(streaming))return;
  reconcileMarkdown(root,buildChatMarkdown(text,streaming));root.dataset.markdown=text;root.dataset.streaming=String(streaming);
}

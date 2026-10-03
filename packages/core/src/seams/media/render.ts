import {RenderDiagramInputSchema,RenderChartInputSchema,type RenderDiagramInput,type RenderChartInput} from "@tracegraph/contracts";
import type {VerifiedImage} from "./image-bytes.js";
const escape=(value:string)=>value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
function svg(title:string,body:string,width:number,height:number):VerifiedImage {return {mimeType:"image/svg+xml",width,height,bytes:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escape(title)}</title><rect width="100%" height="100%" fill="#fff"/><g font-family="sans-serif" font-size="16" fill="#111"><text x="32" y="36">${escape(title)}</text>${body}</g></svg>`)};}
export function renderDiagram(value:RenderDiagramInput):VerifiedImage {
  const input=RenderDiagramInputSchema.parse(value),width=1000,height=100+Math.ceil(input.nodes.length/3)*140;
  const points=new Map(input.nodes.map((node,index)=>[node.id,{x:40+(index%3)*320,y:70+Math.floor(index/3)*140}]));let body="";
  for(const edge of input.edges){const a=points.get(edge.from)!,b=points.get(edge.to)!;body+=`<path d="M ${a.x+140} ${a.y+60} L ${b.x+140} ${b.y}" fill="none" stroke="#555" stroke-width="2"/><circle cx="${b.x+140}" cy="${b.y}" r="4" fill="#555"/>`;if(edge.label)body+=`<text x="${(a.x+b.x)/2+140}" y="${(a.y+b.y)/2+20}" font-size="12">${escape(edge.label.slice(0,30))}</text>`;}
  for(const node of input.nodes){const {x,y}=points.get(node.id)!;body+=`<rect x="${x}" y="${y}" width="280" height="60" rx="8" fill="#eef2ff" stroke="#444"/><text x="${x+12}" y="${y+26}">${escape(node.label.slice(0,28))}</text>${node.label.length>28?`<text x="${x+12}" y="${y+47}" font-size="12">${escape(node.label.slice(28,65))}</text>`:""}`;}
  return svg(input.title,body,width,height);
}
export function renderChart(value:RenderChartInput):VerifiedImage {
  const input=RenderChartInputSchema.parse(value),width=1000,height=640;const min=Math.min(0,...input.values),max=Math.max(0,...input.values),range=max-min||1;
  const y=(number:number)=>80+(max-number)/range*440,zero=y(0),step=880/input.values.length;let body=`<path d="M 60 70 V 530 H 960 M 60 ${zero} H 960" fill="none" stroke="#666"/>`;
  const points:string[]=[];input.values.forEach((value,index)=>{const x=60+step*(index+.5),top=y(value);points.push(`${x},${top}`);if(input.chart_type==="bar")body+=`<rect x="${x-step*.32}" y="${Math.min(top,zero)}" width="${step*.64}" height="${Math.max(1,Math.abs(top-zero))}" fill="#4f46e5"/>`;else body+=`<circle cx="${x}" cy="${top}" r="4" fill="#4f46e5"/>`;body+=`<text x="${x}" y="560" text-anchor="middle" font-size="12">${escape(input.labels[index]!.slice(0,14))}</text><text x="${x}" y="${Math.max(65,top-8)}" text-anchor="middle" font-size="12">${value}</text>`;});
  if(input.chart_type==="line")body+=`<polyline points="${points.join(" ")}" fill="none" stroke="#4f46e5" stroke-width="3"/>`;return svg(input.title,body,width,height);
}

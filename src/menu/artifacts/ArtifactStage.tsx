import { useEffect, useRef, useState } from 'react';
import { ArtifactRenderer } from './renderer';
import type { ArtifactScene } from './types';
import './ArtifactStage.css';

interface Props { scene: ArtifactScene; animated: boolean; intensity: 'still' | 'atmospheric' | 'intense'; powerSaving?: boolean; reaction?: number; offset?: [number,number] }
export function ArtifactStage({scene,animated,intensity,powerSaving=false,reaction=0,offset=[0,0]}:Props) {
 const canvas=useRef<HTMLCanvasElement>(null), yaw=useRef(0), drawRef=useRef<()=>void>(()=>{}), refreshRef=useRef<()=>void>(()=>{}), pointer=useRef<{id:number;x:number}|null>(null);
 const settings=useRef({animated,intensity,powerSaving,reaction,offset}); settings.current={animated,intensity,powerSaving,reaction,offset};
 const [failed,setFailed]=useState(false), [ready,setReady]=useState(false), [running,setRunning]=useState(false);
 useEffect(()=>{const el=canvas.current;if(!el)return;let renderer:ArtifactRenderer|undefined,frame=0,visible=true,lost=false,time=0,last=0,drawn=0; const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const draw=()=>renderer?.draw(time,yaw.current,settings.current.reaction,settings.current.powerSaving,settings.current.offset); drawRef.current=draw;
  const canAnimate=()=>!!renderer&&settings.current.animated&&settings.current.intensity!=='still'&&!settings.current.powerSaving&&!media.matches&&visible&&!document.hidden&&!lost;
  const tick=(now:number)=>{frame=0;if(!canAnimate()){setRunning(false);return;} if(last){const dt=Math.min((now-last)/1000,0.05);time+=dt*(settings.current.intensity==='intense'?1:0.48);}last=now;if(now-drawn>=33){draw();drawn=now;}frame=requestAnimationFrame(tick);};
  const refresh=()=>{if(frame)cancelAnimationFrame(frame);frame=0;last=0;draw();const active=canAnimate();setRunning(active);if(active)frame=requestAnimationFrame(tick);}; refreshRef.current=refresh;
  const create=()=>{try{renderer=new ArtifactRenderer(el,scene);setReady(true);setFailed(false);lost=false;refresh();}catch{renderer=undefined;setReady(false);setRunning(false);setFailed(true);}};
  const contextLost=(event:Event)=>{event.preventDefault();lost=true;if(frame)cancelAnimationFrame(frame);frame=0;setRunning(false);setReady(false);setFailed(true);};
  const contextRestored=()=>{renderer?.dispose();create();};
  const observer=typeof IntersectionObserver!=='undefined'?new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??true;refresh();}):null;observer?.observe(el);
  const resize=typeof ResizeObserver!=='undefined'?new ResizeObserver(refresh):null;resize?.observe(el);window.addEventListener('resize',refresh);document.addEventListener('visibilitychange',refresh);media.addEventListener('change',refresh);el.addEventListener('webglcontextlost',contextLost);el.addEventListener('webglcontextrestored',contextRestored);create();
  return()=>{if(frame)cancelAnimationFrame(frame);observer?.disconnect();resize?.disconnect();window.removeEventListener('resize',refresh);document.removeEventListener('visibilitychange',refresh);media.removeEventListener('change',refresh);el.removeEventListener('webglcontextlost',contextLost);el.removeEventListener('webglcontextrestored',contextRestored);renderer?.dispose();drawRef.current=()=>{};refreshRef.current=()=>{};};
 },[scene]);
 useEffect(()=>{refreshRef.current();},[animated,intensity,powerSaving]);
 useEffect(()=>{drawRef.current();},[reaction,offset[0],offset[1]]);
 return <div className="artifact-stage" role="img" aria-label={`${scene.label}. Mit den Pfeiltasten oder durch horizontales Ziehen drehen.`} aria-keyshortcuts="ArrowLeft ArrowRight Home" tabIndex={0} data-renderer={ready?'webgl':failed?'fallback':'loading'} data-animated={running?'true':'false'}
  onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'||event.key==='Home'){event.preventDefault();yaw.current=event.key==='Home'?0:yaw.current+(event.key==='ArrowLeft'?-0.2:0.2);drawRef.current();}}}
  onPointerDown={event=>{if(event.button!==0||pointer.current)return;pointer.current={id:event.pointerId,x:event.clientX};event.currentTarget.setPointerCapture(event.pointerId);}}
  onPointerMove={event=>{if(pointer.current?.id!==event.pointerId)return;const dx=event.clientX-pointer.current.x;pointer.current.x=event.clientX;yaw.current+=dx*0.01;drawRef.current();}}
  onPointerUp={event=>{if(pointer.current?.id===event.pointerId)pointer.current=null;}} onPointerCancel={event=>{if(pointer.current?.id===event.pointerId)pointer.current=null;}} onLostPointerCapture={event=>{if(pointer.current?.id===event.pointerId)pointer.current=null;}}>
  <canvas ref={canvas} aria-hidden="true" />{failed&&<span className="artifact-stage__fallback">3D-Darstellung nicht verfügbar: {scene.label}</span>}
 </div>;
}

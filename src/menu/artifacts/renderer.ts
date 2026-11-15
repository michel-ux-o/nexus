import type { ArtifactScene, Vec3 } from './types';

const vertex = `attribute vec3 aPosition; attribute vec3 aNormal;
uniform mat3 uRotation; uniform vec3 uScale; uniform vec3 uPosition; uniform float uAspect; uniform float uZoom; uniform vec2 uOffset;
varying vec3 vNormal; varying vec3 vPosition;
void main(){ vec3 p=uRotation*(aPosition*uScale)+uPosition; vPosition=p; vNormal=normalize(uRotation*(aNormal/max(abs(uScale),vec3(0.0001)))); float z=7.0-p.z; gl_Position=vec4(p.x*uZoom/uAspect+uOffset.x*z,p.y*uZoom+uOffset.y*z,z-0.2,z); }`;
const fragment = `precision mediump float; varying vec3 vNormal; varying vec3 vPosition;
uniform vec3 uColor; uniform vec3 uLight; uniform float uOpacity; uniform float uEmissive; uniform float uMetallic;
void main(){ vec3 n=normalize(vNormal); if(!gl_FrontFacing)n=-n; vec3 l=normalize(uLight); vec3 v=normalize(vec3(0.,0.,7.)-vPosition); vec3 h=normalize(l+v); vec3 fill=normalize(vec3(-0.7,0.35,0.65)); float diffuse=max(dot(n,l),0.); float fillLight=max(dot(n,fill),0.); float hemi=0.5+0.5*n.y; float rim=pow(1.-max(dot(n,v),0.),2.5); float spec=pow(max(dot(n,h),0.),mix(22.,75.,uMetallic)); vec3 reflected=reflect(-v,n); float environment=pow(max(0.,1.-abs(reflected.y-0.35)),8.); vec3 color=uColor*(0.14+hemi*0.18+diffuse*0.72+fillLight*0.16+rim*0.38+uEmissive)+mix(vec3(0.7),uColor,0.65)*spec*(0.35+uMetallic*0.8)+mix(vec3(0.18,0.23,0.3),uColor,0.45)*environment*uMetallic*0.4; gl_FragColor=vec4(color,uOpacity); }`;
function shader(gl: WebGLRenderingContext, type: number, source: string) { const s=gl.createShader(type); if(!s) throw Error('Shader konnte nicht erstellt werden'); try {gl.shaderSource(s,source); gl.compileShader(s); if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error('Shader konnte nicht kompiliert werden'); return s;} catch(error) {gl.deleteShader(s);throw error;} }
function rotation(x:number,y:number,z:number): Float32Array { const cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z); return new Float32Array([cy*cz,cy*sz,-sy,sx*sy*cz-cx*sz,sx*sy*sz+cx*cz,sx*cy,cx*sy*cz+sx*sz,cx*sy*sz-sx*cz,cx*cy]); }
function transformedPosition(position:Vec3, orbit:Vec3, time:number, yaw:number): Vec3 { const m=rotation(orbit[0]*time,orbit[1]*time,orbit[2]*time), p:Vec3=[m[0]*position[0]+m[3]*position[1]+m[6]*position[2],m[1]*position[0]+m[4]*position[1]+m[7]*position[2],m[2]*position[0]+m[5]*position[1]+m[8]*position[2]];return [p[0]*Math.cos(yaw)+p[2]*Math.sin(yaw),p[1],-p[0]*Math.sin(yaw)+p[2]*Math.cos(yaw)]; }
export class ArtifactRenderer {
 private gl:WebGLRenderingContext; private program!:WebGLProgram; private buffers: {position:WebGLBuffer;normal:WebGLBuffer;count:number;centroid:Vec3}[]=[];
 private uniforms:Record<string,WebGLUniformLocation|null>={}; private attributes:Record<string,number>={}; private maxDimension!:number;
 constructor(private canvas:HTMLCanvasElement,private scene:ArtifactScene){
  const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true}); if(!gl)throw Error('WebGL nicht verfügbar'); this.gl=gl;
  let vs:WebGLShader|null=null,fs:WebGLShader|null=null,program:WebGLProgram|null=null; const allocated:WebGLBuffer[]=[];
  try {
   vs=shader(gl,gl.VERTEX_SHADER,vertex);fs=shader(gl,gl.FRAGMENT_SHADER,fragment);program=gl.createProgram(); if(!program)throw Error('WebGL-Programm nicht verfügbar'); gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('WebGL-Programm konnte nicht geladen werden'); this.program=program;
   this.maxDimension=Math.min(2048,gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
   for(const name of ['uRotation','uScale','uPosition','uAspect','uZoom','uOffset','uColor','uLight','uOpacity','uEmissive','uMetallic'])this.uniforms[name]=gl.getUniformLocation(program,name);
   for(const name of ['aPosition','aNormal'])this.attributes[name]=gl.getAttribLocation(program,name);
   for(const m of scene.meshes){const position=gl.createBuffer();if(!position)throw Error('WebGL-Speicher nicht verfügbar');allocated.push(position);const normal=gl.createBuffer();if(!normal)throw Error('WebGL-Speicher nicht verfügbar');allocated.push(normal);gl.bindBuffer(gl.ARRAY_BUFFER,position);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(m.geometry.positions),gl.STATIC_DRAW);gl.bindBuffer(gl.ARRAY_BUFFER,normal);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(m.geometry.normals),gl.STATIC_DRAW);
    const centroid:Vec3=[0,0,0],positions=m.geometry.positions,count=positions.length/3;for(let i=0;i<positions.length;i+=3){centroid[0]+=positions[i];centroid[1]+=positions[i+1];centroid[2]+=positions[i+2];}if(count){centroid[0]/=count;centroid[1]/=count;centroid[2]/=count;}this.buffers.push({position,normal,count,centroid});}
  } catch(error) {for(const buffer of allocated)gl.deleteBuffer(buffer);if(program)gl.deleteProgram(program);throw error;}
  finally {if(vs)gl.deleteShader(vs);if(fs)gl.deleteShader(fs);}
 }
 draw(time:number, yaw:number, reaction:number, lowPower:boolean, offset: [number,number]=[0,0]){const gl=this.gl;if(gl.isContextLost())return;
 // Bound both the pixel count and dimensions with one scale factor: clipping each
 // dimension independently would stretch a wide or tall world.
 const width=Math.max(1,this.canvas.clientWidth),height=Math.max(1,this.canvas.clientHeight),dpr=Math.min(window.devicePixelRatio||1,lowPower?1:1.5);
 const pixelBudget=lowPower?900000:2250000;
 const scale=Math.min(dpr,this.maxDimension/width,this.maxDimension/height,Math.sqrt(pixelBudget/(width*height)));
 const w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
 gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.useProgram(this.program);
 const loc=(name:string)=>this.uniforms[name], vec=(name:string,v:Vec3)=>gl.uniform3fv(loc(name),v); const aspect=width/height;gl.uniform1f(loc('uAspect'),aspect);gl.uniform1f(loc('uZoom'),3.1*(this.scene.zoom??1)*Math.min(1,aspect/0.85));gl.uniform2f(loc('uOffset'),offset[0],offset[1]);vec('uLight',this.scene.light);
 const items=this.scene.meshes.map((m,i)=>{const p=transformedPosition(m.position||[0,0,0],m.orbit||[0,0,0],time,yaw),r=m.rotation||[0,0,0],s=m.spin||[0,0,0],rot=rotation(r[0]+s[0]*time,r[1]+s[1]*time+yaw,r[2]+s[2]*time),scale=m.scale||[1,1,1],c=this.buffers[i].centroid;return {m,i,p,rot,depth:p[2]+rot[2]*c[0]*scale[0]+rot[5]*c[1]*scale[1]+rot[8]*c[2]*scale[2]};});
 items.sort((a,b)=>{const at=(a.m.opacity??1)<1||!!a.m.additive,bt=(b.m.opacity??1)<1||!!b.m.additive;return at===bt?(at?a.depth-b.depth:0):at?1:-1;});
 items.forEach(({m,i,p,rot})=>{const b=this.buffers[i];gl.uniformMatrix3fv(loc('uRotation'),false,rot);vec('uScale',m.scale||[1,1,1]);vec('uPosition',p);vec('uColor',m.color);gl.uniform1f(loc('uOpacity'),m.opacity??1);gl.uniform1f(loc('uEmissive'),(m.emissive||0)+reaction*0.15);gl.uniform1f(loc('uMetallic'),m.metallic||0);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,m.additive?gl.ONE:gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask((m.opacity??1)>=1&&!m.additive);
 for(const [name,buffer] of [['aPosition',b.position],['aNormal',b.normal]] as const){const a=this.attributes[name];gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,3,gl.FLOAT,false,0,0);}gl.drawArrays(m.wireframe?gl.LINES:gl.TRIANGLES,0,b.count);});gl.depthMask(true); }
 dispose(){for(const b of this.buffers){this.gl.deleteBuffer(b.position);this.gl.deleteBuffer(b.normal);}this.gl.deleteProgram(this.program);}
}

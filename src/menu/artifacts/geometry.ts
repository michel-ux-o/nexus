import type { Geometry, Vec3 } from './types';

function mesh(fn: (u: number, v: number) => Vec3, us: number, vs: number): Geometry {
  const positions: number[] = [], normals: number[] = [];
  const point = (u: number, v: number) => fn(u, v);
  const normal = (u: number, v: number): Vec3 => {
    const p = point(u, v), a = point(u + 0.0001, v), b = point(u, v + 0.0001);
    const x: Vec3 = [a[0]-p[0], a[1]-p[1], a[2]-p[2]], y: Vec3 = [b[0]-p[0], b[1]-p[1], b[2]-p[2]];
    const n: Vec3 = [x[1]*y[2]-x[2]*y[1], x[2]*y[0]-x[0]*y[2], x[0]*y[1]-x[1]*y[0]];
    const l = Math.hypot(...n); if (l < 1e-12) { const pl = Math.hypot(...p) || 1; return [p[0]/pl,p[1]/pl,p[2]/pl]; } return [n[0]/l,n[1]/l,n[2]/l];
  };
  const add = (u: number, v: number) => { positions.push(...point(u,v)); normals.push(...normal(u,v)); };
  for (let i=0;i<us;i++) for(let j=0;j<vs;j++) {
    const u=i/us, U=(i+1)/us, v=j/vs, V=(j+1)/vs;
    add(u,v); add(U,v); add(U,V); add(u,v); add(U,V); add(u,V);
  }
  return {positions,normals};
}
export function sphere(radius: number, segments=32, rings=20): Geometry {
  return mesh((u,v) => { const a=u*Math.PI*2, b=v*Math.PI; return [radius*Math.sin(b)*Math.cos(a),radius*Math.cos(b),radius*Math.sin(b)*Math.sin(a)]; },segments,rings);
}
export function torus(major: number, minor: number, segments=48, tubeSegments=12, arc=Math.PI*2): Geometry {
  return mesh((u,v) => {const a=u*arc,b=v*Math.PI*2,r=major+minor*Math.cos(b); return [r*Math.cos(a),minor*Math.sin(b),r*Math.sin(a)];},segments,tubeSegments);
}
export function ring(inner: number, outer: number, segments=48): Geometry {
  return mesh((u,v) => {const a=u*Math.PI*2,r=inner+(outer-inner)*v; return [r*Math.cos(a),0,r*Math.sin(a)];},segments,1);
}
export function prism(radius: number, height: number, sides=6): Geometry {
  const positions: number[]=[], normals: number[]=[];
  const tri=(a:Vec3,b:Vec3,c:Vec3,n:Vec3)=>{positions.push(...a,...b,...c);normals.push(...n,...n,...n);};
  for(let i=0;i<sides;i++){const a=i*2*Math.PI/sides,b=(i+1)*2*Math.PI/sides, A:Vec3=[radius*Math.cos(a),-height/2,radius*Math.sin(a)], B:Vec3=[radius*Math.cos(b),-height/2,radius*Math.sin(b)], C:Vec3=[A[0],height/2,A[2]], D:Vec3=[B[0],height/2,B[2]], n:Vec3=[Math.cos((a+b)/2),0,Math.sin((a+b)/2)]; tri(A,C,D,n);tri(A,D,B,n);tri([0,height/2,0],D,C,[0,1,0]);tri([0,-height/2,0],A,B,[0,-1,0]);} return {positions,normals};
}
export function polyhedron(radius: number, detail=0): Geometry {
  const t=(1+Math.sqrt(5))/2; const verts:Vec3[]=[[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]];
  const norm=(v:Vec3):Vec3=>{const l=Math.hypot(...v);return [v[0]*radius/l,v[1]*radius/l,v[2]*radius/l];};
  const p=verts.map(norm), faces=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  const positions:number[]=[],normals:number[]=[];
  const face=(a:Vec3,b:Vec3,c:Vec3,d:number)=>{if(d>0){const mid=(x:Vec3,y:Vec3)=>norm([x[0]+y[0],x[1]+y[1],x[2]+y[2]]);const ab=mid(a,b),bc=mid(b,c),ca=mid(c,a);face(a,ab,ca,d-1);face(b,bc,ab,d-1);face(c,ca,bc,d-1);face(ab,bc,ca,d-1);return;} const x:Vec3=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],y:Vec3=[c[0]-a[0],c[1]-a[1],c[2]-a[2]],n:Vec3=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];const l=Math.hypot(...n)||1; for(const v of [a,b,c]){positions.push(...v);normals.push(n[0]/l,n[1]/l,n[2]/l);}};
  for(const [a,b,c] of faces) face(p[a],p[b],p[c],Math.max(0,Math.min(3,Math.floor(detail)))); return {positions,normals};
}

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

type Point4 = [number, number, number, number];
const vertices: Point4[] = Array.from({ length: 16 }, (_, vertex) =>
  [0, 1, 2, 3].map(axis => (vertex & (1 << axis)) ? 1 : -1) as Point4);
const edges = vertices.flatMap((_, index) => [0, 1, 2, 3]
  .map(axis => [index, index ^ (1 << axis)] as const).filter(([a, b]) => a < b));

function rotate(point: Point4, a: number, b: number, angle: number) {
  const x = point[a], y = point[b];
  point[a] = x * Math.cos(angle) - y * Math.sin(angle);
  point[b] = x * Math.sin(angle) + y * Math.cos(angle);
}

/** A 4D hypercube, rotated in four planes and perspective-projected into 2D. */
export function Tesseract({ animated }: { animated: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orientation = useRef({ x: 0, y: 0 });
  const time = useRef(0);
  const drag = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const redraw = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let size = 0;
    let frame = 0;
    let lastTime = 0;
    let lastDraw = 0;

    const draw = () => {
      if (!size) return;
      const center = size / 2;
      context.clearRect(0, 0, size, size);
      const points = vertices.map(vertex => {
        const point: Point4 = [...vertex];
        rotate(point, 0, 3, time.current * .16 + .24);
        rotate(point, 1, 3, time.current * .1 + .19);
        rotate(point, 0, 2, .3 + orientation.current.x);
        rotate(point, 1, 2, -.38 + orientation.current.y);
        const perspective4 = 3.8 / (3.8 - point[3]);
        const x = point[0] * perspective4;
        const y = point[1] * perspective4;
        const z = point[2] * perspective4;
        const perspective3 = 6 / (6 - z);
        const scale = size * .185 * perspective3;
        return { x: center + x * scale, y: center + y * scale, z };
      });

      const glow = context.createRadialGradient(center, center, 0, center, center, size * .46);
      glow.addColorStop(0, 'rgba(147, 106, 214, .09)');
      glow.addColorStop(1, 'rgba(147, 106, 214, 0)');
      context.fillStyle = glow;
      context.fillRect(0, 0, size, size);

      [...edges].sort(([a, b], [c, d]) => points[a].z + points[b].z - points[c].z - points[d].z)
        .forEach(([a, b]) => {
          const depth = Math.max(.38, Math.min(1, .72 + (points[a].z + points[b].z) * .1));
          context.beginPath();
          context.moveTo(points[a].x, points[a].y);
          context.lineTo(points[b].x, points[b].y);
          context.strokeStyle = (a ^ b) === 8 ? `rgba(163, 194, 255, ${depth})` : `rgba(207, 182, 255, ${depth})`;
          context.lineWidth = depth > .65 ? 1.4 : 1;
          context.shadowColor = 'rgba(174, 124, 255, .35)';
          context.shadowBlur = depth > .65 ? 7 : 0;
          context.stroke();
        });
      context.shadowBlur = 0;
      points.forEach(point => {
        context.beginPath();
        context.arc(point.x, point.y, point.z > 0 ? 1.6 : 1.1, 0, Math.PI * 2);
        context.fillStyle = point.z > 0 ? '#e1c9ff' : '#a88aca';
        context.fill();
      });
    };
    redraw.current = draw;

    const resize = () => {
      size = canvas.getBoundingClientRect().width;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(size * ratio);
      canvas.height = Math.round(size * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const tick = (timestamp: number) => {
      if (lastTime && !drag.current) time.current += Math.min(timestamp - lastTime, 100) / 1000;
      lastTime = timestamp;
      // A quiet wireframe needs no more than thirty frames per second.
      if (timestamp - lastDraw >= 1000 / 30) { draw(); lastDraw = timestamp; }
      frame = requestAnimationFrame(tick);
    };
    if (animated) frame = requestAnimationFrame(tick);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); redraw.current = () => undefined; };
  }, [animated]);

  function move(event: PointerEvent<HTMLCanvasElement>) {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    orientation.current.x += (event.clientX - start.x) * .008;
    orientation.current.y += (event.clientY - start.y) * .008;
    drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    redraw.current();
  }

  function key(event: KeyboardEvent<HTMLCanvasElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') orientation.current = { x: 0, y: 0 };
    if (event.key === 'ArrowLeft') orientation.current.x -= .12;
    if (event.key === 'ArrowRight') orientation.current.x += .12;
    if (event.key === 'ArrowUp') orientation.current.y -= .12;
    if (event.key === 'ArrowDown') orientation.current.y += .12;
    redraw.current();
  }

  return <canvas ref={canvasRef} className="menu-tesseract-canvas" tabIndex={0} role="img"
    aria-label="Drehbarer Tesserakt. Mit Ziehen oder den Pfeiltasten drehen, mit Pos1 zurücksetzen."
    onPointerDown={event => {
      if (event.button !== 0) return;
      drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={move}
    onPointerUp={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={key} />;
}

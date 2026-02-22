import { useEffect, useRef } from 'react';

const VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 v_uv;
  uniform float u_time;
  uniform vec2 u_resolution;

  // Barrel distortion for CRT curvature
  vec2 curveUV(vec2 uv) {
    uv = uv * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    uv *= 1.0 + 0.3 * r2;
    return uv * 0.5 + 0.5;
  }

  // Pseudo-random noise
  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 uv = v_uv;
    vec2 curved = curveUV(uv);

    // Out of bounds after curvature = black border
    if (curved.x < 0.0 || curved.x > 1.0 || curved.y < 0.0 || curved.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 0.85);
      return;
    }

    float alpha = 0.0;
    vec3 color = vec3(0.0);

    // ── Scanlines ──────────────────────────────────
    float scanline = sin(curved.y * u_resolution.y * 1.5) * 0.5 + 0.5;
    scanline = pow(scanline, 1.5);
    alpha += scanline * 0.08;

    // ── Vignette ───────────────────────────────────
    vec2 vigUV = curved * 2.0 - 1.0;
    float vig = 1.0 - dot(vigUV * 0.7, vigUV * 0.7);
    vig = clamp(vig, 0.0, 1.0);
    vig = pow(vig, 1.2);
    alpha += (1.0 - vig) * 0.35;

    // ── Curvature edge darkening ───────────────────
    float edgeDist = length(curved - 0.5) * 2.0;
    float curveDark = smoothstep(0.9, 1.4, edgeDist);
    alpha += curveDark * 0.5;

    // ── Refresh line ───────────────────────────────
    float refreshY = fract(u_time * 0.15);
    float refreshDist = abs(curved.y - refreshY);
    float refresh = smoothstep(0.03, 0.0, refreshDist);
    color += vec3(0.3, 0.6, 0.3) * refresh * 0.15;
    alpha = max(alpha, refresh * 0.08);

    // ── Grain / noise ──────────────────────────────
    float grain = rand(curved * u_resolution + vec2(u_time * 100.0));
    grain = (grain - 0.5) * 0.06;
    alpha += grain;

    // ── Subtle horizontal RGB shift at edges ───────
    float rgbShift = smoothstep(0.3, 0.0, abs(curved.x - 0.5) - 0.35);
    color.r += rgbShift * 0.01;
    color.b -= rgbShift * 0.01;

    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.6));
  }
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl, vs, fs) {
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export default function CrtShader() {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
    if (!gl) {
      console.warn('WebGL not available, CRT shader disabled');
      return;
    }

    // Compile shaders
    const vs = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const program = createProgram(gl, vs, fs);
    if (!program) return;

    // Full-screen quad
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW);

    const aPosition = gl.getAttribLocation(program, 'a_position');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const uResolution = gl.getUniformLocation(program, 'u_resolution');

    // Resize handler
    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const { width, height } = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement);
    resize();

    // Enable blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Render loop
    const startTime = performance.now();
    const render = () => {
      const time = (performance.now() - startTime) / 1000;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(program);
      gl.enableVertexAttribArray(aPosition);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

      gl.uniform1f(uTime, time);
      gl.uniform2f(uResolution, canvas.width, canvas.height);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(positionBuffer);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 20,
      }}
    />
  );
}

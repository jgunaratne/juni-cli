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
  uniform vec2 u_resolution;
  uniform sampler2D u_source;

  float rbgToluminance(vec3 rgb) {
    return (rgb.r * 0.3) + (rgb.g * 0.59) + (rgb.b * 0.11);
  }

  void main() {
    vec2 uv = v_uv;
    vec2 pixelSize = 1.5 / u_resolution;

    vec2 right = vec2(pixelSize.x, 0.0);
    vec2 up = vec2(0.0, pixelSize.y);

    // Sample center and neighbors for bloom
    vec3 colorC = texture2D(u_source, uv).rgb;
    vec3 colorT = texture2D(u_source, uv + up).rgb;
    vec3 colorB = texture2D(u_source, uv - up).rgb;
    vec3 colorL = texture2D(u_source, uv - right).rgb;
    vec3 colorR = texture2D(u_source, uv + right).rgb;

    vec2 right2 = right * 2.0;
    vec2 up2 = up * 2.0;

    vec3 colorTR = texture2D(u_source, uv + up2 + right2).rgb;
    vec3 colorTL = texture2D(u_source, uv + up2 - right2).rgb;
    vec3 colorBR = texture2D(u_source, uv - up2 + right2).rgb;
    vec3 colorBL = texture2D(u_source, uv - up2 - right2).rgb;

    vec3 color = colorC
      + (colorT + colorB + colorL + colorR) * 0.03
      + (colorTR + colorTL + colorBR + colorBL) * 0.01;

    // Tonemap
    float lum = rbgToluminance(color);
    color += vec3(lum * 0.01);
    color = color / (0.5 + mix(vec3(lum), color, 0.95));

    // Gamma
    color = pow(color, vec3(1.0 / 2.2));

    gl_FragColor = vec4(color, 1.0);
  }
`;

// Fallback shader when no source canvas is available (DOM-based content)
const FALLBACK_FRAGMENT = `
  precision mediump float;
  varying vec2 v_uv;
  uniform float u_time;
  uniform vec2 u_resolution;

  void main() {
    vec2 uv = v_uv;
    // Scanlines
    float scanline = sin(uv.y * u_resolution.y * 1.5) * 0.5 + 0.5;
    scanline = pow(scanline, 1.8);
    float alpha = scanline * 0.06;

    // Vignette
    vec2 vig = uv * 2.0 - 1.0;
    float v = 1.0 - dot(vig * 0.65, vig * 0.65);
    alpha += (1.0 - clamp(pow(v, 1.2), 0.0, 1.0)) * 0.3;

    // Refresh line
    float rl = abs(uv.y - fract(u_time * 0.12));
    alpha += smoothstep(0.025, 0.0, rl) * 0.06;

    gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(alpha, 0.0, 0.5));
  }
`;

function compileShader(gl, type, source) {
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

function linkProgram(gl, vs, fs) {
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

function findSourceCanvas(parent) {
  // xterm renders to a canvas inside .xterm-screen
  const xtermCanvas = parent.querySelector('.xterm-screen canvas');
  if (xtermCanvas) return xtermCanvas;
  // Fallback: any canvas sibling that isn't ours
  const canvases = parent.querySelectorAll('canvas');
  for (const c of canvases) {
    if (!c.dataset.crtShader) return c;
  }
  return null;
}

export default function CrtShader() {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.dataset.crtShader = 'true';

    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
    if (!gl) return;

    const parent = canvas.parentElement;
    const sourceCanvas = findSourceCanvas(parent);
    const usePostProcess = !!sourceCanvas;

    // Pick the right fragment shader
    const fragSource = usePostProcess ? FRAGMENT_SHADER : FALLBACK_FRAGMENT;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
    if (!vs || !fs) return;

    const program = linkProgram(gl, vs, fs);
    if (!program) return;

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(program, 'a_position');
    const uRes = gl.getUniformLocation(program, 'u_resolution');
    const uSource = usePostProcess ? gl.getUniformLocation(program, 'u_source') : null;
    const uTime = !usePostProcess ? gl.getUniformLocation(program, 'u_time') : null;

    // Create texture for source canvas
    let texture = null;
    if (usePostProcess) {
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    // Enable blending for fallback mode
    if (!usePostProcess) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    const resize = () => {
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
    observer.observe(parent);
    resize();

    const startTime = performance.now();
    const render = () => {
      const time = (performance.now() - startTime) / 1000;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(program);
      gl.enableVertexAttribArray(aPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(uRes, canvas.width, canvas.height);

      if (usePostProcess && sourceCanvas) {
        // Upload the terminal canvas as a texture each frame
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
        } catch {
          // Canvas might be tainted or unavailable
        }
        gl.uniform1i(uSource, 0);
      } else if (uTime) {
        gl.uniform1f(uTime, time);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      if (texture) gl.deleteTexture(texture);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
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

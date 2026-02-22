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
  uniform int u_frame;
  uniform sampler2D u_source;

  const float SHADOWMASK_VERTGAPWIDTH = 0.02;
  const float SHADOWMASK_VERTHARDNESS = 0.1;
  const float SHADOWMASK_HORIZGAPWIDTH = -1.0;
  const float SHADOWMASK_HORIZARDNESS = 0.8;
  const float SHADOWMASK_RCOL_OFFSET = 0.0;
  const float SHADOWMASK_GCOL_OFFSET = -0.3;
  const float SHADOWMASK_BCOL_OFFSET = -0.6;

  const float SCANLINE_RGAPWIDTH = 2.0;
  const float SCANLINE_RHARDNESS = 1.0;
  const float SCANLINE_ROFFSET = 0.0 + 0.08333333;
  const float SCANLINE_GGAPWIDTH = 2.0;
  const float SCANLINE_GHARDNESS = 0.5;
  const float SCANLINE_GOFFSET = -0.1 + 0.08333333;
  const float SCANLINE_BGAPWIDTH = 2.0;
  const float SCANLINE_BHARDNESS = 0.3;
  const float SCANLINE_BOFFSET = -0.15 + 0.08333333;

  const float SHADOWMASK_UV_SCALE = 0.12;
  const float SCANLINE_UV_SCALE = 60.0;
  const float SINE_SCALE = 3.14159 * 2.0;

  // tanh polyfill for GLSL ES 1.0
  float tanh_approx(float x) {
    float e2x = exp(2.0 * x);
    return (e2x - 1.0) / (e2x + 1.0);
  }

  // SHADOW MASK
  float Grille(float x, float offset, float multiplier) {
    return smoothstep(0.0, 1.0, sin(x * SINE_SCALE) * multiplier + offset);
  }

  float ShadowMaskRows(vec2 uv) {
    uv.x *= 0.5;
    uv.x -= floor(uv.x + 0.5);
    if (uv.x < 0.0)
      uv.y += 0.5;
    return Grille(uv.y, -SHADOWMASK_HORIZGAPWIDTH, SHADOWMASK_HORIZARDNESS);
  }

  float ShadowMaskSingleCol(float x) {
    return Grille(x, -SHADOWMASK_VERTGAPWIDTH, SHADOWMASK_VERTHARDNESS);
  }

  vec3 ShadowMaskRGBCols(float x) {
    return vec3(
      ShadowMaskSingleCol(x + SHADOWMASK_RCOL_OFFSET),
      ShadowMaskSingleCol(x + SHADOWMASK_GCOL_OFFSET),
      ShadowMaskSingleCol(x + SHADOWMASK_BCOL_OFFSET)
    );
  }

  vec3 ShadowMask(vec2 uv) {
    return ShadowMaskRGBCols(uv.x) * ShadowMaskRows(uv);
  }

  // SCANLINES
  float Scanline(float x, float offset, float multiplier) {
    return tanh_approx(sin(x * SINE_SCALE) * multiplier + offset) * 0.5 + 0.5;
  }

  float Interlacing() {
    int frame = u_frame / 2;
    return mod(float(frame), 2.0) < 1.0 ? 0.5 : 0.0;
  }

  vec4 Sample(vec2 uv, float resolution) {
    if (uv.x < 0.0 || uv.x > 1.0) return vec4(0.0);
    if (uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);

    float interlacing = Interlacing();
    uv *= resolution;
    uv.y += interlacing;

    vec2 uv1 = vec2(uv.x, ceil(uv.y));
    vec2 uv2 = vec2(uv.x, floor(uv.y));
    float t = uv.y - floor(uv.y);
    t = smoothstep(0.0, 1.0, t);

    uv1.y -= interlacing;
    uv2.y -= interlacing;

    vec4 sample1 = texture2D(u_source, uv1 / resolution);
    vec4 sample2 = texture2D(u_source, uv2 / resolution);

    return mix(sample2, sample1, vec4(t));
  }

  vec3 ScanlinesRGB(float y) {
    y += Interlacing();
    return vec3(
      Scanline(y + SCANLINE_ROFFSET, -SCANLINE_RGAPWIDTH, SCANLINE_RHARDNESS),
      Scanline(y + SCANLINE_GOFFSET, -SCANLINE_GGAPWIDTH, SCANLINE_GHARDNESS),
      Scanline(y + SCANLINE_BOFFSET, -SCANLINE_BGAPWIDTH, SCANLINE_BHARDNESS)
    );
  }

  float rbgToluminance(vec3 rgb) {
    return (rgb.r * 0.3) + (rgb.g * 0.59) + (rgb.b * 0.11);
  }

  // CRT curvature
  vec2 curve(vec2 uv) {
    uv = (uv - 0.5) * 2.0;
    uv *= 1.1;
    uv.x *= 1.0 + pow((abs(uv.y) / 5.0), 2.0);
    uv.y *= 1.0 + pow((abs(uv.x) / 4.0), 2.0);
    uv = (uv / 2.0) + 0.5;
    uv = uv * 0.92 + 0.04;
    return uv;
  }

  void main() {
    vec2 uv = v_uv;
    vec2 sampleUV = curve(uv);
    vec2 shadowMaskUV = sampleUV * min(u_resolution, vec2(1920.0, 1080.0)) * SHADOWMASK_UV_SCALE;
    vec2 scanlineUV = sampleUV * SCANLINE_UV_SCALE;

    // Input signal
    vec3 color = Sample(sampleUV, SCANLINE_UV_SCALE).rgb;

    // Convert to linear
    color = pow(color, vec3(2.2));

    // Vignette
    float vig = abs(16.0 * sampleUV.x * sampleUV.y * (1.0 - sampleUV.x) * (1.0 - sampleUV.y));
    color *= vec3(pow(vig, 0.6));

    // Scanlines
    color *= ScanlinesRGB(scanlineUV.y) * 40.0;

    // Shadow mask
    color *= ShadowMask(shadowMaskUV) * 500.0;

    // Tonemap
    color += vec3(rbgToluminance(color) * 0.05);
    color = color / (0.5 + color);

    // Convert to gamma
    color = pow(color, vec3(1.0 / 2.2));

    gl_FragColor = vec4(color, 1.0);
  }
`;

// Fallback for DOM-based panels (no source canvas)
const FALLBACK_FRAGMENT = `
  precision mediump float;
  varying vec2 v_uv;
  uniform float u_time;
  uniform vec2 u_resolution;

  void main() {
    vec2 uv = v_uv;
    float scanline = sin(uv.y * u_resolution.y * 1.5) * 0.5 + 0.5;
    scanline = pow(scanline, 1.8);
    float alpha = scanline * 0.06;

    vec2 vig = uv * 2.0 - 1.0;
    float v = 1.0 - dot(vig * 0.65, vig * 0.65);
    alpha += (1.0 - clamp(pow(v, 1.2), 0.0, 1.0)) * 0.3;

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
  const xtermCanvas = parent.querySelector('.xterm-screen canvas');
  if (xtermCanvas) return xtermCanvas;
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
    const parent = canvas.parentElement;

    let cleanupFn = null;

    function init(sourceCanvas) {
      const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
      if (!gl) return;

      const usePostProcess = !!sourceCanvas;
      const fragSource = usePostProcess ? FRAGMENT_SHADER : FALLBACK_FRAGMENT;

      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
      if (!vs || !fs) return;

      const program = linkProgram(gl, vs, fs);
      if (!program) return;

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]), gl.STATIC_DRAW);

      const aPos = gl.getAttribLocation(program, 'a_position');
      const uRes = gl.getUniformLocation(program, 'u_resolution');
      const uSource = usePostProcess ? gl.getUniformLocation(program, 'u_source') : null;
      const uFrame = usePostProcess ? gl.getUniformLocation(program, 'u_frame') : null;
      const uTime = !usePostProcess ? gl.getUniformLocation(program, 'u_time') : null;

      let texture = null;
      if (usePostProcess) {
        texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }

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

      let frameCount = 0;
      const startTime = performance.now();

      const render = () => {
        const time = (performance.now() - startTime) / 1000;
        frameCount++;

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(program);
        gl.enableVertexAttribArray(aPos);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        gl.uniform2f(uRes, canvas.width, canvas.height);

        if (usePostProcess && sourceCanvas) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
          } catch {
            // Canvas may be tainted
          }
          gl.uniform1i(uSource, 0);
          gl.uniform1i(uFrame, frameCount);
        } else if (uTime) {
          gl.uniform1f(uTime, time);
        }

        gl.drawArrays(gl.TRIANGLES, 0, 6);
        rafRef.current = requestAnimationFrame(render);
      };

      rafRef.current = requestAnimationFrame(render);

      cleanupFn = () => {
        cancelAnimationFrame(rafRef.current);
        observer.disconnect();
        if (texture) gl.deleteTexture(texture);
        gl.deleteProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.deleteBuffer(buf);
      };
    }

    // Wait for the source canvas (xterm renders async)
    let retryTimer = null;
    let retryCount = 0;
    const maxRetries = 30; // ~3 seconds

    function tryInit() {
      const sourceCanvas = findSourceCanvas(parent);
      if (sourceCanvas) {
        init(sourceCanvas);
        return;
      }
      retryCount++;
      if (retryCount < maxRetries) {
        retryTimer = setTimeout(tryInit, 100);
      } else {
        // Give up finding a canvas, use fallback
        init(null);
      }
    }

    tryInit();

    return () => {
      clearTimeout(retryTimer);
      if (cleanupFn) cleanupFn();
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

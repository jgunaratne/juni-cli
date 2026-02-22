import { useEffect, useRef } from 'react';

const VERTEX_SHADER = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  uniform float u_time;
  uniform vec2 u_resolution;

  float time;

  float noise(vec2 p) {
    return sin(p.x * 10.) * sin(p.y * (3. + sin(time / 11.))) + .2;
  }

  mat2 rotate(float angle) {
    return mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
  }

  float fbm(vec2 p) {
    p *= 1.1;
    float f = 0.;
    float amp = .5;
    for (int i = 0; i < 3; i++) {
      mat2 modify = rotate(time / 50. * float(i * i));
      f += amp * noise(p);
      p = modify * p;
      p *= 2.;
      amp /= 2.2;
    }
    return f;
  }

  float pattern(vec2 p, out vec2 q, out vec2 r) {
    q = vec2(fbm(p + vec2(1.)), fbm(rotate(.1 * time) * p + vec2(1.)));
    r = vec2(fbm(rotate(.1) * q + vec2(0.)), fbm(q + vec2(0.)));
    return fbm(p + 1. * r);
  }

  float sampleFont(vec2 p, float num) {
    float glyph[2];
    if (num < 1.)      { glyph[0] = 0.91333008; glyph[1] = 0.89746094; }
    else if (num < 2.) { glyph[0] = 0.27368164; glyph[1] = 0.06933594; }
    else if (num < 3.) { glyph[0] = 1.87768555; glyph[1] = 1.26513672; }
    else if (num < 4.) { glyph[0] = 1.87719727; glyph[1] = 1.03027344; }
    else if (num < 5.) { glyph[0] = 1.09643555; glyph[1] = 1.51611328; }
    else if (num < 6.) { glyph[0] = 1.97045898; glyph[1] = 1.03027344; }
    else if (num < 7.) { glyph[0] = 0.97045898; glyph[1] = 1.27246094; }
    else if (num < 8.) { glyph[0] = 1.93945312; glyph[1] = 1.03222656; }
    else if (num < 9.) { glyph[0] = 0.90893555; glyph[1] = 1.27246094; }
    else               { glyph[0] = 0.90893555; glyph[1] = 1.52246094; }

    float pos = floor(p.x + p.y * 5.);
    if (pos < 13.) {
      return step(1., mod(pow(2., pos) * glyph[0], 2.));
    } else {
      return step(1., mod(pow(2., pos - 13.) * glyph[1], 2.));
    }
  }

  float digit(vec2 p) {
    p -= vec2(0.5, 0.5);
    p *= (1. + 0.15 * pow(length(p), 0.6));
    p += vec2(0.5, 0.5);

    p.x += sin(u_time / 7.) / 5.;
    p.y += sin(u_time / 13.) / 5.;

    vec2 grid = vec2(3., 1.) * 15.;
    vec2 s = floor(p * grid) / grid;
    p = p * grid;
    vec2 q;
    vec2 r;
    float intensity = pattern(s / 10., q, r) * 1.3 - 0.03;
    p = fract(p);
    p *= vec2(1.2, 1.2);
    float x = fract(p.x * 5.);
    float y = fract((1. - p.y) * 5.);
    vec2 fpos = vec2(floor(p.x * 5.), floor((1. - p.y) * 5.));
    float isOn = sampleFont(fpos, floor(intensity * 10.));
    return p.x <= 1. && p.y <= 1. ? isOn * (0.2 + y * 4. / 5.) * (0.75 + x / 4.) : 0.;
  }

  float hash(float x) {
    return fract(sin(x * 234.1) * 324.19 + sin(sin(x * 3214.09) * 34.132 * x) + x * 234.12);
  }

  float onOff(float a, float b, float c) {
    return step(c, sin(u_time + a * cos(u_time * b)));
  }

  float displace(vec2 look) {
    float y = (look.y - mod(u_time / 4., 1.));
    float window = 1. / (1. + 50. * y * y);
    return sin(look.y * 20. + u_time) / 80. * onOff(4., 2., .8) * (1. + cos(u_time * 60.)) * window;
  }

  vec3 getColor(vec2 p) {
    float bar = mod(p.y + time * 20., 1.) < 0.2 ? 1.4 : 1.;
    p.x += displace(p);
    float middle = digit(p);
    float off = 0.002;
    float sum = 0.;
    for (float i = -1.; i < 2.; i += 1.) {
      for (float j = -1.; j < 2.; j += 1.) {
        sum += digit(p + vec2(off * i, off * j));
      }
    }
    return vec3(0.9) * middle + sum / 10. * vec3(0., 1., 0.) * bar;
  }

  void main() {
    time = u_time / 3.;
    vec2 p = gl_FragCoord.xy / u_resolution.xy;
    vec3 col = getColor(p);
    gl_FragColor = vec4(col, 1.0);
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

    const vs = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const program = createProgram(gl, vs, fs);
    if (!program) return;

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW);

    const aPosition = gl.getAttribLocation(program, 'a_position');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const uResolution = gl.getUniformLocation(program, 'u_resolution');

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
        mixBlendMode: 'screen',
      }}
    />
  );
}

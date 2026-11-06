"use client";

import { useEffect, useRef } from "react";
import type { CinematicMode } from "@/components/cinematic-chrome";

/**
 * Hero background — a faithful port of Amplemarket's home-hero WebGL shader
 * (assets.amplemarket.com/.../home-hero.min.js). Three metaball blobs blended
 * additively with exclusion ("circle - circle*circle"): a pointer-tracked blob
 * (col1/cyan) + two slow time-animated blobs (col2/lavender, col3/orange), with
 * in-shader film grain. The canvas is transparent (alpha) so the page base
 * (#f6f5f3) shows through; a soft radial mask confines the wash to the
 * lower-left/bottom so the headline area stays clean (their site masks it to a
 * shaped path — we fade alpha in-shader). Blob colors are the app accent
 * tokens: --color-glow-violet / --color-glow-orange / --color-glow-pink.
 *
 * Time runs slow (0.0025·elapsed ms) and the pointer eases in at 0.025, exactly
 * like the source. Paused offscreen (IntersectionObserver) + on tab-hide;
 * prefers-reduced-motion renders a single static frame.
 */

const VERT = `
    attribute vec3 aPosition;
    void main() {
      vec4 positionVec4 = vec4(aPosition, 1.0);
      positionVec4.xy = positionVec4.xy * 2.0 - 1.0;
      gl_Position = positionVec4;
    }
  `;

const FRAG = `
    #ifdef GL_ES
    precision highp float;
    #endif

    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_mouse;
    uniform float u_dpr;
    uniform vec3 u_col1;
    uniform vec3 u_col2;
    uniform vec3 u_col3;

    float rand(vec2 co){
      // Divide by sqrt(dpr), not dpr: full /dpr makes the film grain nearly
      // vanish on 2–3× phones (the wash reads flat); sqrt keeps texture on
      // hi-DPI while still tempering shimmer.
      return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453) / sqrt(u_dpr);
    }

    vec4 circle(vec2 st, vec2 center, float radius, float blur, vec3 col){
      float dist = distance(st,center)*2.0;
      vec4 f_col = vec4(1.0-smoothstep(radius, radius + blur, dist));
      f_col.r *= col.r;
      f_col.g *= col.g;
      f_col.b *= col.b;
      return f_col;
    }

    void main(){
      vec2 fst = gl_FragCoord.xy/u_resolution.xy;
      float aspect = u_resolution.x/u_resolution.y;
      vec2 mst = fst;
      vec2 m = u_mouse.xy/u_resolution.xy;

      // Portrait: this metaball field is authored for landscape, so sampling it
      // across a tall screen smears the blobs into vertical streaks. Instead,
      // render the SAME desktop composition scaled down into a band at the
      // bottom (fieldAspect ~ desktop), then the corner mask below keeps the
      // glow bottom-right exactly like desktop. Above the band, coords run past
      // [0,1] so the blobs fade to clean base. Landscape is left untouched.
      float portrait = 0.0;
      if (aspect < 1.0) {
        portrait = 1.0;
        float fieldAspect = 0.85;            // <1 → taller glow band (square=1.0; lower = taller)
        float bandH = aspect / fieldAspect;  // bottom fraction of height it fills
        fst = vec2(fst.x, fst.y / bandH);
        mst = fst;
        aspect = fieldAspect;
      }

      vec3 col1 = u_col1 / 255.;
      vec3 col2 = u_col2 / 255.;
      vec3 col3 = u_col3 / 255.;

      vec4 color = vec4(0.);

      vec2 purpleC = vec2(m.x, 1.-m.y);
      float purpleR = .75;
      float purpleB = .75;
      vec3 purpleCol = col1;

      vec2 mintC = vec2(.5+sin(u_time*.4)*.5*cos(u_time*.2)*.5, .5+sin(u_time*.3)*.5*cos(u_time*.5)*.5);
      float mintR = 1.;
      float mintB = 1.;
      vec3 mintCol = col2;

      vec2 greenC = vec2((.5+cos(u_time*.5)*.5*sin(u_time*.2)*.5)*aspect, .5+cos(u_time*.4)*(.5)*sin(u_time*.3)*.5);
      float greenR = 1.;
      float greenB = 1.;
      vec3 greenCol = col3;

      mst.x += cos(u_time*.37+mst.x*15.)*.21 * sin(u_time*.14+mst.y*7.)*.29 * (m.x - .5) * 12.;
      mst.y += sin(u_time*.15+mst.x*13.)*.37 * cos(u_time*.36+mst.y*5.)*.12 * (m.y - .5) * 12.;

      vec4 color1 = vec4(0.);
      vec4 color2 = vec4(0.);
      vec4 color3 = vec4(0.);
      vec4 color4 = vec4(0.);
      vec4 color5 = vec4(0.);

      color1 += vec4(
        (circle(mst, mintC, mintR, mintB, vec3(1.))
        - circle(mst, mintC, mintR, mintB, vec3(1.)) * circle(mst, greenC, greenR, greenB, vec3(1.)))
      );

      color2 += vec4(
        (circle(mst, mintC, mintR, mintB, vec3(1.))
        - circle(mst, mintC, mintR, mintB, vec3(1.)) * circle(mst, purpleC, purpleR, purpleB, vec3(1.)))
      );

      color1 -= color1 * color2;
      color2 -= color1 * color2;

      color3 = color1;
      color4 = color2;
      color3.rgb *= purpleCol;
      color4.rgb *= greenCol;

      color += color3;
      color += color4;

      color5 += vec4(
        (circle(mst, greenC, greenR, greenB, vec3(1.))
        - circle(mst, greenC, greenR, greenB, vec3(1.)) * circle(mst, mintC, mintR, mintB, vec3(1.)))
      );
      color5 -= color1 * color2;
      color5.rgb *= mintCol;
      color += color5;

      color += circle(mst, mintC, mintR, mintB, mintCol)
        * (color1 - circle(mst, mintC, mintR, mintB, vec3(1.)))
        * (color2 - circle(mst, mintC, mintR, mintB, vec3(1.)));

      float noise = rand(fst*10.) * .2;
      color.rgb *= 1. - vec3(noise);

      // Confine the wash to a contained glow in the bottom-right corner so most
      // of the page reads as clean base. (Their site clips the canvas to a
      // shaped path; we fade alpha by distance from a corner anchor.) On
      // portrait this runs in the scaled-down field space from the top, so the
      // glow lands bottom-right just like desktop.
      vec2 mc = vec2(0.85, 0.15);
      vec2 dd = vec2(fst.x*aspect, fst.y) - vec2(mc.x*aspect, mc.y);
      // Portrait: weight the horizontal distance so the glow falls off faster
      // going LEFT (less left spread) while a larger radius lets it reach
      // UPWARD — a tall, bottom-right-anchored ellipse. Desktop stays circular.
      dd.x *= mix(1.0, 1.65, portrait);
      float md = length(dd);
      color *= 1.0 - smoothstep(0.24, mix(0.64, 1.5, portrait), md);

      gl_FragColor = color;
    }
  `;

/** Read a #rrggbb token as [r,g,b] in 0..255 (the shader divides by 255). */
function readRGB(name: string, fallback: [number, number, number]) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(v);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as [
    number,
    number,
    number,
  ];
}

function makeShader(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
}

export function GradientField({ mode }: { mode: CinematicMode }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const gl =
      (canvas.getContext("webgl", {
        antialias: false,
        alpha: true,
        powerPreference: "low-power",
      }) as WebGLRenderingContext | null) ??
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
    if (!gl) return;

    const vs = makeShader(gl, gl.VERTEX_SHADER, VERT);
    const fs = makeShader(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    const aPos = gl.getAttribLocation(prog, "aPosition");
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const uRes = gl.getUniformLocation(prog, "u_resolution");
    const uTime = gl.getUniformLocation(prog, "u_time");
    const uMouse = gl.getUniformLocation(prog, "u_mouse");
    const uDpr = gl.getUniformLocation(prog, "u_dpr");
    const uC1 = gl.getUniformLocation(prog, "u_col1");
    const uC2 = gl.getUniformLocation(prog, "u_col2");
    const uC3 = gl.getUniformLocation(prog, "u_col3");
    // gradient blobs use the Trellis glow palette (orange / violet / pink, from alpha402)
    // softened toward white so the wash stays pastel like alpha402 (full-strength orange reads too heavy)
    const soften = (c: number[], k = 0.55) => c.map((v) => Math.round(v + (255 - v) * k));
    const c1 = soften(readRGB("--color-glow-violet", [139, 111, 199]));
    const c2 = soften(readRGB("--color-glow-orange", [249, 115, 22]));
    const c3 = soften(readRGB("--color-glow-pink", [236, 72, 153]));

    let w = 0;
    let h = 0;
    const resize = () => {
      const nw = Math.round(canvas.clientWidth * dpr);
      const nh = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== nw || canvas.height !== nh) {
        canvas.width = nw;
        canvas.height = nh;
      }
      w = canvas.width;
      h = canvas.height;
    };
    resize();

    const startedAt = Date.now();
    const target: [number, number] = [w / 2, h / 2];
    const ptr = { x: w / 2, y: h / 2 };

    const render = () => {
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.enableVertexAttribArray(aPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2fv(uRes, [w, h]);
      gl.uniform1f(uTime, 0.0025 * (Date.now() - startedAt));
      gl.uniform2fv(uMouse, [ptr.x, ptr.y]);
      gl.uniform1f(uDpr, dpr);
      gl.uniform3fv(uC1, c1);
      gl.uniform3fv(uC2, c2);
      gl.uniform3fv(uC3, c3);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const onMove = (e: MouseEvent) => {
      target[0] = e.clientX * dpr;
      target[1] = e.clientY * dpr;
    };

    let raf = 0;
    let running = false;
    const frame = () => {
      resize();
      ptr.x += (target[0] - ptr.x) * 0.025;
      ptr.y += (target[1] - ptr.y) * 0.025;
      render();
      if (running) raf = requestAnimationFrame(frame);
    };

    if (reduced) {
      ptr.x = w / 2;
      ptr.y = h / 2;
      render();
    } else {
      running = true;
      window.addEventListener("mousemove", onMove);
      raf = requestAnimationFrame(frame);
    }
    window.addEventListener("resize", resize);

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !running && !reduced) {
          running = true;
          window.addEventListener("mousemove", onMove);
          raf = requestAnimationFrame(frame);
        } else if (!entry.isIntersecting && running) {
          running = false;
          window.removeEventListener("mousemove", onMove);
          cancelAnimationFrame(raf);
        }
      },
      { rootMargin: "100px" },
    );
    io.observe(canvas);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={
        "pointer-events-none fixed inset-0 z-0 h-full w-screen transition-opacity duration-700 " +
        (mode === "bright" ? "opacity-100" : "opacity-60")
      }
    />
  );
}

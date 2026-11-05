// Trellis video effects: injects a WebGL background + extra GSAP motion into the composed HyperFrames page.
// Run after compose.mjs (it overwrites index.html):
//   node demo/video-fx.mjs --take demo-video/take --project demo-video/hyperframes
//
// Deterministic: everything is driven by the composition's paused GSAP timeline. HyperFrames seeks it per frame
// (tl.seek suppresses callbacks), so the shader redraws from property setters, batched once per seek.
import fs from 'fs';
import path from 'path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const TAKE = path.resolve(arg('take', 'demo-video/take'));
const PROJECT = path.resolve(arg('project', 'demo-video/hyperframes'));
const file = `${PROJECT}/index.html`;
let html = fs.readFileSync(file, 'utf8');
if (html.includes('id="fx"')) { console.log('video-fx: already applied'); process.exit(0); }

// section timings from the composed page
const sec = (id) => {
  const m = html.match(new RegExp(`<section id="${id}"[^>]*data-start="([0-9.]+)" data-duration="([0-9.]+)"`));
  return m ? { s: +m[1], d: +m[2] } : null;
};
const intro = sec('intro'), problem = sec('problem'), app = sec('app'), outro = sec('outro');
const TOTAL = +html.match(/data-composition-id="main" data-start="0" data-duration="([0-9.]+)"/)[1];

// chapter times in composition time (same mapping compose.mjs uses: footage starts 1.4 s before chapter 1)
const chapters = JSON.parse(fs.readFileSync(`${TAKE}/chapters.json`, 'utf8')).filter((c) => c.html);
const skip = Math.max(0, chapters[0].t - 1.4);
const at = (n) => { const c = chapters.find((x) => x.html.startsWith(`<b>${n} ·`)); return c ? +(app.s + c.t - skip).toFixed(2) : null; };
const T = { crash: at(4), protect: at(5), money: at(6), record: at(7) };

const FRAG = `
precision highp float;
uniform vec2 R; uniform float T, uLat, uDraw, uCrash, uCalm, uWipe, uHeal;
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;} vec2 mod289(vec2 x){return x-floor(x*(1./289.))*289.;}
vec3 permute(vec3 x){return mod289(((x*34.)+1.)*x);}
float snoise(vec2 v){ const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
  vec2 i=floor(v+dot(v,C.yy)); vec2 x0=v-i+dot(i,C.xx); vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
  vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.); m=m*m; m=m*m;
  vec3 x=2.*fract(p*C.www)-1.; vec3 h=abs(x)-.5; vec3 ox=floor(x+.5); vec3 a0=x-ox;
  m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
  vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw; return 130.*dot(m,g); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<3;i++){ s+=a*snoise(p); p*=1.9; a*=.5; } return s; }
void main(){
  vec2 uv = gl_FragCoord.xy / R;
  vec2 p = (gl_FragCoord.xy - .5*R) / R.y;
  vec3 base = vec3(.965,.961,.953);
  float t = T*.03;
  // domain-warped aurora (Trellis glow colours)
  vec2 q = vec2(fbm(p*.5 + vec2(0., t)), fbm(p*.5 + vec2(5.2, -t)));
  vec2 r = vec2(fbm(p*.6 + 1.2*q + vec2(1.7, 9.2) + t*.7), fbm(p*.6 + 1.2*q + vec2(8.3, 2.8) - t*.5));
  float f = fbm(p*.55 + 1.3*r);
  vec3 orange = vec3(.976,.451,.086), violet = vec3(.545,.435,.78), pink = vec3(.925,.282,.6), purple = vec3(.69,.31,.78);
  vec3 col = mix(orange, violet, smoothstep(-.4, .6, r.x));
  col = mix(col, pink, smoothstep(.2, .9, q.y) * .5);
  col = mix(col, vec3(.93,.24,.17), uCrash * .65);          // crash: hot red-orange
  col = mix(col, vec3(.2,.78,.55), uHeal * .6);             // protected: mint green
  float amt = smoothstep(-.05, .75, f);
  float edge = smoothstep(.12, .95, length(uv - vec2(.36, .58)) * 1.3);   // keep the text area clean
  float strength = mix(.5, .26, uCalm) * (.2 + .8*edge);
  strength += uCrash * .16 * (.5 + .5*sin(T*7.));
  vec3 c = mix(base, col, amt * strength);
  // trellis lattice: a 45 degree grid that draws itself on, with sap pulses travelling along it
  vec2 g = gl_FragCoord.xy / (R.y/8.);
  vec2 d = vec2(g.x + g.y, g.x - g.y) * .7071;
  vec2 fd = abs(fract(d) - .5);
  float line = 1. - smoothstep(.0, .055, min(fd.x, fd.y));
  float reveal = 1. - smoothstep(uDraw*1.7 - .3, uDraw*1.7, (uv.x + uv.y) * .85);
  float pulse = pow(.5 + .5*sin((d.x + d.y)*1.5 - T*2.4 + f*3.), 6.);
  float lat = line * reveal * uLat * (.10 + .55*pulse) * (.5 + .5*edge);
  c = mix(c, mix(mix(orange, purple, uv.x), vec3(.93,.24,.17), uCrash*.5), lat);
  // wipe: a soft light band sweeping diagonally between sections
  float band = exp(-pow(((uv.x + uv.y)*.5 - (uWipe*1.5 - .25)) * 8., 2.)) * step(.001, uWipe) * step(uWipe, .999);
  c += band * .38 * mix(orange, purple, uv.y);
  gl_FragColor = vec4(c, 1.);
}`;

const SCRIPT = `
    <script>
    (function () {
      var tl = window.__timelines && window.__timelines.main;
      var cv = document.getElementById('fx');
      var gl = cv && cv.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, alpha: false });
      if (!tl || !gl) return;
      function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
      var pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }'));
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, ${JSON.stringify(FRAG)}));
      gl.linkProgram(pr); gl.useProgram(pr);
      var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      var names = ['T', 'uLat', 'uDraw', 'uCrash', 'uCalm', 'uWipe', 'uHeal'];
      var L = {}; names.forEach(function (n) { L[n] = gl.getUniformLocation(pr, n); });
      gl.uniform2f(gl.getUniformLocation(pr, 'R'), cv.width, cv.height);
      var V = { T: 0, uLat: 1, uDraw: 0, uCrash: 0, uCalm: 0, uWipe: 0, uHeal: 0 };
      function draw() { names.forEach(function (n) { gl.uniform1f(L[n], V[n]); }); gl.viewport(0, 0, cv.width, cv.height); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      // one redraw per seek, after every tween of that seek has written its value
      var queued = false;
      var U = {};
      names.forEach(function (n) {
        Object.defineProperty(U, n, { get: function () { return V[n]; }, set: function (v) {
          V[n] = v; if (!queued) { queued = true; Promise.resolve().then(function () { queued = false; draw(); }); } } });
      });
      var I = ${JSON.stringify({ intro, problem, app, outro, TOTAL, T })};
      tl.fromTo(U, { T: 0 }, { T: I.TOTAL, duration: I.TOTAL, ease: 'none' }, 0);
      // intro: the lattice draws itself on
      tl.fromTo(U, { uDraw: 0 }, { uDraw: 1, duration: 2.6, ease: 'power2.out' }, 0.1);
      // wipes between sections
      [I.problem && I.problem.s, I.app.s, I.outro && I.outro.s].filter(Boolean).forEach(function (s) {
        tl.fromTo(U, { uWipe: 0 }, { uWipe: 1, duration: 1.1, ease: 'power1.inOut', immediateRender: false }, s - 0.45);
      });
      // problem card: the crash heats the background
      if (I.problem) {
        tl.to(U, { uCrash: 0.85, duration: 0.8, ease: 'power2.out' }, I.problem.s + 0.3);
        tl.to(U, { uCrash: 0, duration: 0.8 }, I.problem.s + I.problem.d - 0.6);
      }
      // footage: calm, faint lattice behind the app
      tl.to(U, { uCalm: 1, uLat: 0.22, duration: 1.2 }, I.app.s - 0.2);
      if (I.T.crash) tl.to(U, { uCrash: 0.7, duration: 0.9, ease: 'power2.out' }, I.T.crash + 0.4);
      if (I.T.money) {
        tl.to(U, { uCrash: 0, uHeal: 1, duration: 1.6 }, I.T.money - 0.4);
        tl.to(U, { uHeal: 0.25, duration: 2.5 }, (I.T.record || I.T.money + 8) - 0.5);
      }
      // outro: full aurora, lattice draws on again
      if (I.outro) {
        tl.to(U, { uCalm: 0, uHeal: 0, uLat: 1, duration: 1 }, I.outro.s - 0.3);
        tl.fromTo(U, { uDraw: 0 }, { uDraw: 1, duration: 2.4, ease: 'power2.out', immediateRender: false }, I.outro.s);
      }
      // the trellis mark strokes itself in (intro + outro logos)
      tl.fromTo('#logo .c svg path', { strokeDasharray: 140, strokeDashoffset: 140 }, { strokeDashoffset: 0, duration: 1.6, ease: 'power2.inOut' }, 0.15);
      if (I.outro) tl.fromTo('#o-logo .c svg path', { strokeDasharray: 140, strokeDashoffset: 140 }, { strokeDashoffset: 0, duration: 1.6, ease: 'power2.inOut', immediateRender: false }, I.outro.s + 0.2);
      // the gradient headline keeps moving
      tl.fromTo('#t2 span', { backgroundPosition: '0% 50%' }, { backgroundPosition: '100% 50%', duration: I.intro.d, ease: 'none' }, 0);
      tl.seek(0);
      draw();
    })();
    </script>`;

html = html
  .replace(/(<div id="root"[^>]*>)/, `$1\n      <canvas id="fx" width="960" height="540"></canvas>`)
  .replace('</style>', `      #fx { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; z-index: 0; pointer-events: none; }\n      #t2 span { background-size: 240% 100% !important; }\n    </style>`)
  .replace(/(\n\s*<\/body>)/, `${SCRIPT}$1`);
fs.writeFileSync(file, html);
console.log(`video-fx: WebGL background + motion added (crash ${T.crash}s, money flow ${T.money}s, total ${TOTAL}s)`);

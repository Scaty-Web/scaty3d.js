/* scaty3d.js
   fixed WASD & movement (delta-time, normalization), space preventDefault, mesh.size bugfix
   exports: Scaty3D, Box, Mesh, loadTex
*/
(function(){

/* ---------- math (column-major) ---------- */
const mat4 = {
  identity(){ return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); },

  perspective(fov, aspect, near, far){
    const f = 1.0/Math.tan(fov*0.5);
    const nf = 1/(near - far);
    const out = new Float32Array(16);
    out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1;
    out[14] = (2 * far * near) * nf; out[15] = 0;
    return out;
  },

  multiply(a,b){
    const o = new Float32Array(16);
    for (let i=0;i<4;i++){
      for (let j=0;j<4;j++){
        o[j*4 + i] =
          a[i] * b[j*4 + 0] +
          a[i + 4] * b[j*4 + 1] +
          a[i + 8] * b[j*4 + 2] +
          a[i + 12]* b[j*4 + 3];
      }
    }
    return o;
  },

  translate(x,y,z){
    const m = mat4.identity();
    m[12]=x; m[13]=y; m[14]=z;
    return m;
  },

  rotationY(r){
    const c=Math.cos(r), s=Math.sin(r);
    return new Float32Array([ c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1 ]);
  },

  rotationX(r){
    const c=Math.cos(r), s=Math.sin(r);
    return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
  },

  modelFromPosRot(x,y,z, rotY){
    return mat4.multiply(mat4.translate(x,y,z), mat4.rotationY(rotY));
  }
};

/* ---------- input ---------- */
// key map + prevent space scrolling
const keys = {};
window.addEventListener("keydown", e=>{
  // prevent page scroll on space
  if(e.code === "Space") e.preventDefault();
  keys[e.key.toLowerCase()] = true;
});
window.addEventListener("keyup", e=>{
  keys[e.key.toLowerCase()] = false;
});

/* ---------- engine core ---------- */
class Scaty3D {
  constructor(canvas, opts={}){
    if(!canvas) throw new Error("canvas required");
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", {antialias: !!opts.antialias});
    if(!this.gl){ alert("WebGL desteklenmiyor"); return; }
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    if(opts.cull !== false){ gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }

    this.scene = [];
    this.camera = new Camera(canvas);
    this._makeProgram();
    this._setGLDefaults();
    this._onResize();
    window.addEventListener("resize", ()=>this._onResize());

    this._running = false;
    this.lastTime = 0;
  }

  start(){ // starts internal loop
    if(this._running) return;
    this._running = true;
    this.lastTime = performance.now();
    const loop = (t)=>{
      if(!this._running) return;
      const dt = (t - this.lastTime) / 1000;
      this.lastTime = t;
      this.render(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop(){ this._running = false; }

  _setGLDefaults(){
    const gl=this.gl;
    gl.clearColor(0.06,0.09,0.16,1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  _onResize(){
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.floor((canvas.clientWidth || window.innerWidth) * dpr);
    const displayH = Math.floor((canvas.clientHeight || window.innerHeight) * dpr);
    if(canvas.width !== displayW || canvas.height !== displayH){
      canvas.width = displayW; canvas.height = displayH;
    }
    this.gl.viewport(0,0,canvas.width, canvas.height);
    const aspect = canvas.width / canvas.height || 1;
    this.camera.proj = mat4.perspective(Math.PI/3, aspect, 0.1, 200.0);
  }

  _makeProgram(){
    const gl = this.gl;
    const vs = `
      attribute vec3 position;
      attribute vec3 normal;
      attribute vec2 uv;
      uniform mat4 uModel;
      uniform mat4 uView;
      uniform mat4 uProj;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vViewPos;
      varying vec2 vUV;
      void main(){
        vec4 worldPos = uModel * vec4(position,1.0);
        vWorldPos = worldPos.xyz;
        vNormal = mat3(uModel) * normal;
        vec4 viewPos = uView * worldPos;
        vViewPos = viewPos.xyz;
        vUV = uv;
        gl_Position = uProj * viewPos;
      }
    `;
    const fs = `
      precision mediump float;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vViewPos;
      varying vec2 vUV;
      uniform sampler2D uTex;
      uniform vec3 uColor;
      uniform vec3 uDirLightDir;
      uniform vec3 uDirLightCol;
      uniform vec3 uPointPos;
      uniform vec3 uPointCol;
      uniform float uPointRange;
      uniform vec3 uSpotPos;
      uniform vec3 uSpotDir;
      uniform vec3 uSpotCol;
      uniform float uSpotCutoff;
      uniform float uSpotRange;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      void main(){
        vec3 N = normalize(vNormal);
        vec3 baseTex = texture2D(uTex, vUV).rgb;
        vec3 base = baseTex * uColor;
        vec3 Ld = normalize(uDirLightDir);
        float diffD = max(dot(N, -Ld), 0.0);
        vec3 col = base * (0.12 + diffD * uDirLightCol);
        vec3 toPoint = uPointPos - vWorldPos;
        float distP = length(toPoint);
        if(distP < uPointRange){
          vec3 Lp = normalize(toPoint);
          float diffP = max(dot(N, Lp), 0.0);
          float att = 1.0 / (1.0 + 0.22*distP + 0.06*distP*distP);
          col += base * (diffP * uPointCol * att);
        }
        vec3 toSpot = uSpotPos - vWorldPos;
        float distS = length(toSpot);
        if(distS < uSpotRange){
          vec3 Ls = normalize(toSpot);
          float spotFactor = dot(normalize(-uSpotDir), Ls);
          if(spotFactor > uSpotCutoff){
            float diffS = max(dot(N, Ls), 0.0);
            float spotAtt = pow(spotFactor, 8.0);
            float att = 1.0 / (1.0 + 0.18*distS + 0.045*distS*distS);
            col += base * (diffS * uSpotCol * spotAtt * att);
          }
        }
        float d = length(vViewPos);
        float fogFactor = smoothstep(uFogNear, uFogFar, d);
        vec3 final = mix(col, uFogColor, fogFactor);
        gl_FragColor = vec4(final, 1.0);
      }
    `;
    this.program = this._createProgram(vs, fs);
    gl.useProgram(this.program);

    // attribute/uniform locations
    this.loc = {
      position: gl.getAttribLocation(this.program, "position"),
      normal:   gl.getAttribLocation(this.program, "normal"),
      uv:       gl.getAttribLocation(this.program, "uv"),
      uModel:   gl.getUniformLocation(this.program, "uModel"),
      uView:    gl.getUniformLocation(this.program, "uView"),
      uProj:    gl.getUniformLocation(this.program, "uProj"),
      uColor:   gl.getUniformLocation(this.program, "uColor"),
      uTex:     gl.getUniformLocation(this.program, "uTex"),
      uDirLightDir: gl.getUniformLocation(this.program, "uDirLightDir"),
      uDirLightCol: gl.getUniformLocation(this.program, "uDirLightCol"),
      uPointPos: gl.getUniformLocation(this.program, "uPointPos"),
      uPointCol: gl.getUniformLocation(this.program, "uPointCol"),
      uPointRange: gl.getUniformLocation(this.program, "uPointRange"),
      uSpotPos: gl.getUniformLocation(this.program, "uSpotPos"),
      uSpotDir: gl.getUniformLocation(this.program, "uSpotDir"),
      uSpotCol: gl.getUniformLocation(this.program, "uSpotCol"),
      uSpotCutoff: gl.getUniformLocation(this.program, "uSpotCutoff"),
      uSpotRange: gl.getUniformLocation(this.program, "uSpotRange"),
      uFogColor: gl.getUniformLocation(this.program, "uFogColor"),
      uFogNear: gl.getUniformLocation(this.program, "uFogNear"),
      uFogFar: gl.getUniformLocation(this.program, "uFogFar")
    };

    // safe uniform setup
    try {
      if(this.loc.uTex) gl.uniform1i(this.loc.uTex, 0);
      if(this.loc.uDirLightDir) gl.uniform3fv(this.loc.uDirLightDir, new Float32Array([0.3,1.0,0.4]));
      if(this.loc.uDirLightCol) gl.uniform3fv(this.loc.uDirLightCol, new Float32Array([1.0,1.0,0.95]));
      if(this.loc.uPointPos) gl.uniform3fv(this.loc.uPointPos, new Float32Array([2,4,0]));
      if(this.loc.uPointCol) gl.uniform3fv(this.loc.uPointCol, new Float32Array([1.0,0.8,0.6]));
      if(this.loc.uPointRange) gl.uniform1f(this.loc.uPointRange, 10.0);
      if(this.loc.uSpotPos) gl.uniform3fv(this.loc.uSpotPos, new Float32Array([-2,4,2]));
      if(this.loc.uSpotDir) gl.uniform3fv(this.loc.uSpotDir, new Float32Array([0,-1,0]));
      if(this.loc.uSpotCol) gl.uniform3fv(this.loc.uSpotCol, new Float32Array([0.6,0.7,1.0]));
      if(this.loc.uSpotCutoff) gl.uniform1f(this.loc.uSpotCutoff, 0.5);
      if(this.loc.uSpotRange) gl.uniform1f(this.loc.uSpotRange, 15.0);
      if(this.loc.uFogColor) gl.uniform3fv(this.loc.uFogColor, new Float32Array([0.06,0.09,0.16]));
      if(this.loc.uFogNear) gl.uniform1f(this.loc.uFogNear, 8.0);
      if(this.loc.uFogFar) gl.uniform1f(this.loc.uFogFar, 40.0);
    } catch(e){
      console.warn("uniform init warning", e);
    }
  }

  _createProgram(vs, fs){
    const gl=this.gl;
    function compile(type, src){
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
        console.error("shader compile:", gl.getShaderInfoLog(s));
      }
      return s;
    }
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p,v); gl.attachShader(p,f); gl.linkProgram(p);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)){
      console.error("program link:", gl.getProgramInfoLog(p));
    }
    return p;
  }

  add(obj){ this.scene.push(obj); }

  handleCollision(cam){
    for(const o of this.scene) this._checkCollisionAndResolve(cam, o);
  }

  _checkCollisionAndResolve(cam, obj){
    const radius = cam.radius || 0.3;
    const playerYFeet = cam.y - cam.eyeHeight;
    const s = obj.size || 1;
    const minX = obj.x - s, maxX = obj.x + s;
    const minZ = obj.z - s, maxZ = obj.z + s;
    const minY = obj.y - s, maxY = obj.y + s;
    if( (cam.y - cam.eyeHeight) > maxY + 0.5 || (cam.y + 0.5) < minY ) return;
    const px = cam.x, pz = cam.z;
    const closestX = Math.max(minX, Math.min(px, maxX));
    const closestZ = Math.max(minZ, Math.min(pz, maxZ));
    const dx = px - closestX, dz = pz - closestZ;
    const dist2 = dx*dx + dz*dz;
    if(dist2 < radius*radius){
      const dist = Math.sqrt(dist2) || 0.0001;
      const pen = radius - dist;
      const nx = dx / dist, nz = dz / dist;
      cam.x += nx * pen;
      cam.z += nz * pen;
      if(playerYFeet < maxY && playerYFeet > minY){
        cam.y = maxY + cam.eyeHeight;
        cam.velY = 0;
        cam.onGround = true;
      }
    }
  }

  render(dt=1/60){
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.camera.update(dt);

    gl.useProgram(this.program);

    for(const o of this.scene){
      o.rotY += o.rotSpeed || 0.0;

      const model = mat4.modelFromPosRot(o.x, o.y, o.z, o.rotY);

      const invPitch = mat4.rotationX(-this.camera.pitch);
      const invYaw   = mat4.rotationY(-this.camera.yaw);
      const trans = mat4.translate(-this.camera.x, -this.camera.y, -this.camera.z);
      const view = mat4.multiply(invPitch, mat4.multiply(invYaw, trans));
      const proj = this.camera.proj;

      if(this.loc.uModel) gl.uniformMatrix4fv(this.loc.uModel, false, model);
      if(this.loc.uView)  gl.uniformMatrix4fv(this.loc.uView, false, view);
      if(this.loc.uProj)  gl.uniformMatrix4fv(this.loc.uProj, false, proj);
      if(this.loc.uColor) gl.uniform3fv(this.loc.uColor, o.color);

      gl.bindBuffer(gl.ARRAY_BUFFER, o.vbo);
      const stride = 8 * 4;
      if(this.loc.position !== -1 && this.loc.position !== null){
        gl.enableVertexAttribArray(this.loc.position);
        gl.vertexAttribPointer(this.loc.position, 3, gl.FLOAT, false, stride, 0);
      }
      if(this.loc.normal !== -1 && this.loc.normal !== null){
        gl.enableVertexAttribArray(this.loc.normal);
        gl.vertexAttribPointer(this.loc.normal, 3, gl.FLOAT, false, stride, 12);
      }
      if(this.loc.uv !== -1 && this.loc.uv !== null){
        gl.enableVertexAttribArray(this.loc.uv);
        gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, stride, 24);
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, o.tex || this._whiteTex());

      // do collision resolution for camera vs this object
      this._checkCollisionAndResolve(this.camera, o);

      gl.drawArrays(gl.TRIANGLES, 0, o.count);
    }
  }

  // convenience setters
  setFog(colorVec3, near=8, far=40){
    const gl = this.gl;
    if(this.loc.uFogColor) gl.uniform3fv(this.loc.uFogColor, new Float32Array(colorVec3));
    if(this.loc.uFogNear) gl.uniform1f(this.loc.uFogNear, near);
    if(this.loc.uFogFar) gl.uniform1f(this.loc.uFogFar, far);
  }
  setDirLight(dirVec3, colVec3){
    const gl = this.gl;
    if(this.loc.uDirLightDir) gl.uniform3fv(this.loc.uDirLightDir, new Float32Array(dirVec3));
    if(this.loc.uDirLightCol) gl.uniform3fv(this.loc.uDirLightCol, new Float32Array(colVec3));
  }
  setPointLight(pos, col, range=10){
    const gl = this.gl;
    if(this.loc.uPointPos) gl.uniform3fv(this.loc.uPointPos, new Float32Array(pos));
    if(this.loc.uPointCol) gl.uniform3fv(this.loc.uPointCol, new Float32Array(col));
    if(this.loc.uPointRange) gl.uniform1f(this.loc.uPointRange, range);
  }

  _whiteTex(){
    if(this._wt) return this._wt;
    const gl=this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this._wt = t;
    return t;
  }
}

/* ---------- camera (fps) ---------- */
class Camera {
  constructor(canvas){
    this.x = 0; this.y = 2.0; this.z = 6;
    this.yaw = 0; this.pitch = 0;
    this.speed = 3.0;         // units per second (reasonable default)
    this.velY = 0;
    this.gravity = -9.8;      // m/s^2 style (we'll scale by dt)
    this.jumpForce = 4.0;     // initial upward velocity
    this.onGround = false;
    this.eyeHeight = 1.6;
    this.radius = 0.34;

    // pointer lock
    canvas.addEventListener("click", ()=>{
      if(document.pointerLockElement !== canvas) canvas.requestPointerLock();
    });
    document.addEventListener("mousemove", (e)=>{
      if(document.pointerLockElement !== canvas) return;
      const sens = 0.0025;
      this.yaw   -= e.movementX * sens;
      this.pitch -= e.movementY * sens;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    });
  }

  update(dt=1/60){
    // dt in seconds
    if(dt <= 0) dt = 1/60;
    // movement vector in local XZ
    let mvx = 0, mvz = 0;
    const forward = [ Math.sin(this.yaw), 0, -Math.cos(this.yaw) ];
    const right   = [ Math.cos(this.yaw), 0,  Math.sin(this.yaw) ];
    if(keys['w']){ mvx += forward[0]; mvz += forward[2]; }
    if(keys['s']){ mvx -= forward[0]; mvz -= forward[2]; }
    if(keys['a']){ mvx -= right[0];   mvz -= right[2]; }
    if(keys['d']){ mvx += right[0];   mvz += right[2]; }

    // normalize horizontal movement to avoid faster diagonal speed
    const len = Math.hypot(mvx, mvz);
    if(len > 0.0001){
      const moveDist = this.speed * dt;
      this.x += (mvx / len) * moveDist;
      this.z += (mvz / len) * moveDist;
    }

    // jump (use code check for safety)
    if((keys[' '] || keys['space']) && this.onGround){
      this.velY = this.jumpForce;
      this.onGround = false;
    }

    // gravity integrated per-second
    // gravity is negative; scale with dt
    this.velY += this.gravity * dt;
    this.y += this.velY * dt;

    // ground collision simple (floor at y = 0)
    const minY = this.eyeHeight;
    if(this.y < minY){
      this.y = minY;
      this.velY = 0;
      this.onGround = true;
    }
  }
}

/* ---------- box geometry ---------- */
class Box {
  constructor(gl, size = 1, tex = null){
    const s = size / 2;
    const verts = [
      -s,-s, s,  0,0,1,  0,0,
       s,-s, s,  0,0,1,  1,0,
       s, s, s,  0,0,1,  1,1,
      -s,-s, s,  0,0,1,  0,0,
       s, s, s,  0,0,1,  1,1,
      -s, s, s,  0,0,1,  0,1,

       s,-s,-s,  0,0,-1, 0,0,
      -s,-s,-s,  0,0,-1, 1,0,
      -s, s,-s,  0,0,-1, 1,1,
       s,-s,-s,  0,0,-1, 0,0,
      -s, s,-s,  0,0,-1, 1,1,
       s, s,-s,  0,0,-1, 0,1,

      -s,-s,-s,  -1,0,0, 0,0,
      -s,-s, s,  -1,0,0, 1,0,
      -s, s, s,  -1,0,0, 1,1,
      -s,-s,-s,  -1,0,0, 0,0,
      -s, s, s,  -1,0,0, 1,1,
      -s, s,-s,  -1,0,0, 0,1,

       s,-s, s,   1,0,0, 0,0,
       s,-s,-s,   1,0,0, 1,0,
       s, s,-s,   1,0,0, 1,1,
       s,-s, s,   1,0,0, 0,0,
       s, s,-s,   1,0,0, 1,1,
       s, s, s,   1,0,0, 0,1,

      -s, s, s,   0,1,0, 0,0,
       s, s, s,   0,1,0, 1,0,
       s, s,-s,   0,1,0, 1,1,
      -s, s, s,   0,1,0, 0,0,
       s, s,-s,   0,1,0, 1,1,
      -s, s,-s,   0,1,0, 0,1,

      -s,-s,-s,   0,-1,0, 0,0,
       s,-s,-s,   0,-1,0, 1,0,
       s,-s, s,   0,-1,0, 1,1,
      -s,-s,-s,   0,-1,0, 0,0,
       s,-s, s,   0,-1,0, 1,1,
      -s,-s, s,   0,-1,0, 0,1
    ];
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    this.count = verts.length / 8;
    this.tex = tex;
    this.size = size/2;
  }
}

/* ---------- mesh wrapper ---------- */
class Mesh {
  constructor(geo){
    this.vbo = geo.vbo;
    this.count = geo.count;
    this.tex = geo.tex;
    // geo.size exists (half-extent) from Box
    this.size = (typeof geo.size === "number") ? geo.size : 1;
    this.x = 0; this.y = 0; this.z = -6;
    this.rotY = 0;
    this.rotSpeed = 0;
    this.color = new Float32Array([1.0,1.0,1.0]);
  }
}

/* ---------- texture loader ---------- */
function isPowerOfTwo(v){ return (v & (v - 1)) === 0; }
function loadTex(gl, url, onload){
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = function(){
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);
    if(isPowerOfTwo(img.width) && isPowerOfTwo(img.height)){
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if(onload) onload(tex);
  };
  img.onerror = function(){
    console.warn("texture load failed:", url);
    if(onload) onload(null);
  };
  img.src = url;
  return tex;
}

/* ---------- exports ---------- */
window.Scaty3D = Scaty3D;
window.Box = Box;
window.Mesh = Mesh;
window.loadTex = loadTex;

})(); // eof

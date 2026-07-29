"use strict";
(function (global) {
    function compileShader(gl, type, source) {
        var shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            var message = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error("Errore shader: " + message);
        }
        return shader;
    }

    function createProgram(gl, vertexSource, fragmentSource) {
        var vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
        var fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
        var program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            var message = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error("Errore linking WebGL: " + message);
        }
        return program;
    }

    function createTexture(gl, unit) {
        var texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }

    function copyPlane(heap, pointer, stride, width, height) {
        if (!pointer || !stride || width <= 0 || height <= 0) {
            throw new Error("Piano YUV non valido.");
        }
        var result = new Uint8Array(width * height);
        if (stride === width) {
            result.set(heap.subarray(pointer, pointer + width * height));
            return result;
        }
        for (var row = 0; row < height; row += 1) {
            var sourceStart = pointer + row * stride;
            result.set(
                heap.subarray(sourceStart, sourceStart + width),
                row * width
            );
        }
        return result;
    }

    function SoftwareYuvRenderer(canvas) {
        var gl = canvas.getContext("webgl", {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false
        }) || canvas.getContext("experimental-webgl");
        if (!gl) throw new Error("WebGL non disponibile.");

        var vertexSource = [
            "attribute vec2 a_position;",
            "attribute vec2 a_texCoord;",
            "varying vec2 v_texCoord;",
            "void main(){",
            "gl_Position=vec4(a_position,0.0,1.0);",
            "v_texCoord=vec2(a_texCoord.x,1.0-a_texCoord.y);",
            "}"
        ].join("\n");

        var fragmentSource = [
            "precision mediump float;",
            "varying vec2 v_texCoord;",
            "uniform sampler2D u_textureY;",
            "uniform sampler2D u_textureU;",
            "uniform sampler2D u_textureV;",
            "uniform float u_fullRange;",
            "uniform float u_bt709;",
            "void main(){",
            "float rawY=texture2D(u_textureY,v_texCoord).r;",
            "float u=texture2D(u_textureU,v_texCoord).r-0.5;",
            "float v=texture2D(u_textureV,v_texCoord).r-0.5;",
            "float y=mix(1.16438356*(rawY-0.06274510),rawY,u_fullRange);",
            "vec3 rgb601=vec3(y+1.59602678*v,y-0.39176229*u-0.81296764*v,y+2.01723214*u);",
            "vec3 rgb709=vec3(y+1.79274107*v,y-0.21324861*u-0.53290933*v,y+2.11240179*u);",
            "gl_FragColor=vec4(clamp(mix(rgb601,rgb709,u_bt709),0.0,1.0),1.0);",
            "}"
        ].join("\n");

        var program = createProgram(gl, vertexSource, fragmentSource);
        gl.useProgram(program);
        var vertices = new Float32Array([
            -1,-1,0,0, 1,-1,1,0, -1,1,0,1,
            -1,1,0,1, 1,-1,1,0, 1,1,1,1
        ]);
        var buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        var pos = gl.getAttribLocation(program, "a_position");
        var tex = gl.getAttribLocation(program, "a_texCoord");
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(tex);
        gl.vertexAttribPointer(tex, 2, gl.FLOAT, false, 16, 8);

        this.gl = gl;
        this.canvas = canvas;
        this.textures = [createTexture(gl,0), createTexture(gl,1), createTexture(gl,2)];
        gl.uniform1i(gl.getUniformLocation(program,"u_textureY"),0);
        gl.uniform1i(gl.getUniformLocation(program,"u_textureU"),1);
        gl.uniform1i(gl.getUniformLocation(program,"u_textureV"),2);
        this.fullRangeLocation = gl.getUniformLocation(program,"u_fullRange");
        this.bt709Location = gl.getUniformLocation(program,"u_bt709");
        this.width = 0;
        this.height = 0;
        gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
        gl.clearColor(0,0,0,1);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    SoftwareYuvRenderer.prototype.capture = function (module, frame) {
        var cw = Math.ceil(frame.width / 2);
        var ch = Math.ceil(frame.height / 2);
        return {
            pts: frame.pts,
            width: frame.width,
            height: frame.height,
            matrix: frame.matrix,
            fullRange: frame.fullRange,
            y: copyPlane(module.HEAPU8, frame.y, frame.strideY, frame.width, frame.height),
            u: copyPlane(module.HEAPU8, frame.u, frame.strideU, cw, ch),
            v: copyPlane(module.HEAPU8, frame.v, frame.strideV, cw, ch)
        };
    };

    SoftwareYuvRenderer.prototype.ensureTextures = function (width, height) {
        if (this.width === width && this.height === height) return;
        this.width = width;
        this.height = height;
        this.canvas.width = width;
        this.canvas.height = height;
        var gl = this.gl;
        var cw = Math.ceil(width / 2);
        var ch = Math.ceil(height / 2);
        var sizes = [[width,height],[cw,ch],[cw,ch]];
        for (var i=0;i<3;i+=1) {
            gl.activeTexture(gl.TEXTURE0+i);
            gl.bindTexture(gl.TEXTURE_2D,this.textures[i]);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,sizes[i][0],sizes[i][1],0,gl.LUMINANCE,gl.UNSIGNED_BYTE,null);
        }
    };

    SoftwareYuvRenderer.prototype.render = function (frame) {
        this.ensureTextures(frame.width, frame.height);
        var gl = this.gl;
        var cw = Math.ceil(frame.width / 2);
        var ch = Math.ceil(frame.height / 2);
        var planes = [frame.y,frame.u,frame.v];
        var sizes = [[frame.width,frame.height],[cw,ch],[cw,ch]];
        for (var i=0;i<3;i+=1) {
            gl.activeTexture(gl.TEXTURE0+i);
            gl.bindTexture(gl.TEXTURE_2D,this.textures[i]);
            gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,sizes[i][0],sizes[i][1],gl.LUMINANCE,gl.UNSIGNED_BYTE,planes[i]);
        }
        gl.uniform1f(this.fullRangeLocation,frame.fullRange?1:0);
        gl.uniform1f(this.bt709Location,frame.matrix===709?1:0);
        gl.viewport(0,0,frame.width,frame.height);
        gl.drawArrays(gl.TRIANGLES,0,6);
    };

    SoftwareYuvRenderer.prototype.clear = function () {
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    };

    global.SoftwareYuvRenderer = SoftwareYuvRenderer;
}(window));

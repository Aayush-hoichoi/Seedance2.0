'use client';

// Three.js aurora for the landing hero. A fullscreen fbm shader in the locked
// palette (paper-0 ground, violet accent) plus a sparse drifting dust field.
// Degrades gracefully: no WebGL → the CSS wash behind the canvas carries the
// frame; prefers-reduced-motion → a single still frame, no animation loop;
// scrolled out of view → the render loop pauses.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const AURORA_VERT = /* glsl */ `
varying vec2 v_uv;
void main() {
    v_uv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const AURORA_FRAG = /* glsl */ `
precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform vec2 u_pointer;
varying vec2 v_uv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
    );
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = p * 2.03 + vec2(11.7, 5.3);
        a *= 0.5;
    }
    return v;
}

void main() {
    vec2 uv = v_uv;
    vec2 p = (uv - 0.5) * vec2(u_res.x / max(u_res.y, 1.0), 1.0);
    p += u_pointer * 0.05;

    float t = u_time * 0.032;
    float n = fbm(p * 1.5 + vec2(t, -t * 0.65));
    n = fbm(p * 1.15 + n * 1.35 + vec2(-t * 0.55, t * 0.85));

    vec3 base = vec3(0.047, 0.047, 0.063);   /* paper-0 #0C0C10 */
    vec3 violet = vec3(0.545, 0.486, 0.965); /* accent #8B7CF6 */
    vec3 bright = vec3(0.647, 0.600, 0.973); /* accent-hi #A599F8 */

    float band = smoothstep(0.38, 0.9, n);
    float crown = smoothstep(0.08, 0.85, uv.y); /* strongest behind the headline */
    vec3 col = base;
    col += violet * band * crown * 0.34;
    col += bright * pow(band, 3.0) * crown * 0.20;

    float vig = smoothstep(1.28, 0.3, length(uv - vec2(0.5, 0.6)));
    col = mix(base, col, vig);
    col += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) * 0.014; /* dither — kills banding */

    gl_FragColor = vec4(col, 1.0);
}`;

const DUST_VERT = /* glsl */ `
attribute float aPhase;
attribute float aSpeed;
uniform float u_time;
uniform float u_dpr;
varying float v_alpha;
void main() {
    vec3 p = position;
    p.y = mod(p.y + u_time * aSpeed * 0.018 + 1.0, 2.0) - 1.0;
    p.x += sin(u_time * 0.12 + aPhase) * 0.01;
    v_alpha = 0.08 + 0.20 * (0.5 + 0.5 * sin(u_time * 0.7 + aPhase * 3.0));
    gl_Position = vec4(p.xy, 0.0, 1.0);
    gl_PointSize = (1.0 + 2.2 * fract(aPhase)) * u_dpr;
}`;

const DUST_FRAG = /* glsl */ `
precision mediump float;
varying float v_alpha;
void main() {
    vec2 d = gl_PointCoord - 0.5;
    float m = smoothstep(0.5, 0.1, length(d));
    gl_FragColor = vec4(0.75, 0.72, 0.95, v_alpha * m);
}`;

const DUST_COUNT = 260;

function buildDust(dpr) {
    const positions = new Float32Array(DUST_COUNT * 3);
    const phases = new Float32Array(DUST_COUNT);
    const speeds = new Float32Array(DUST_COUNT);
    for (let i = 0; i < DUST_COUNT; i++) {
        positions[i * 3] = Math.random() * 2 - 1;
        positions[i * 3 + 1] = Math.random() * 2 - 1;
        positions[i * 3 + 2] = 0;
        phases[i] = Math.random() * Math.PI * 2;
        speeds[i] = 0.4 + Math.random() * 1.2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    const uniforms = { u_time: { value: 0 }, u_dpr: { value: dpr } };
    const material = new THREE.ShaderMaterial({
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    return { points: new THREE.Points(geometry, material), uniforms, geometry, material };
}

export default function HeroCanvas() {
    const hostRef = useRef(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;

        let renderer;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power' });
        } catch {
            return undefined; // no WebGL — the CSS wash behind us carries the hero
        }

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        renderer.setPixelRatio(dpr);
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        const auroraUniforms = {
            u_time: { value: 0 },
            u_res: { value: new THREE.Vector2(1, 1) },
            u_pointer: { value: new THREE.Vector2(0, 0) },
        };
        const auroraGeometry = new THREE.PlaneGeometry(2, 2);
        const auroraMaterial = new THREE.ShaderMaterial({
            vertexShader: AURORA_VERT,
            fragmentShader: AURORA_FRAG,
            uniforms: auroraUniforms,
            depthTest: false,
            depthWrite: false,
        });
        scene.add(new THREE.Mesh(auroraGeometry, auroraMaterial));

        const dust = buildDust(dpr);
        scene.add(dust.points);

        const observer = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            if (!width || !height) return;
            renderer.setSize(width, height, false);
            auroraUniforms.u_res.value.set(width, height);
            if (reduceMotion) renderer.render(scene, camera);
        });
        observer.observe(host);

        // Pointer parallax, eased toward the target in the render loop.
        const pointerTarget = { x: 0, y: 0 };
        const onPointerMove = (e) => {
            pointerTarget.x = (e.clientX / window.innerWidth - 0.5) * 2;
            pointerTarget.y = (e.clientY / window.innerHeight - 0.5) * 2;
        };
        window.addEventListener('pointermove', onPointerMove, { passive: true });

        let raf = 0;
        let visible = true;
        const start = performance.now();
        const tick = () => {
            const t = (performance.now() - start) / 1000;
            auroraUniforms.u_time.value = t;
            dust.uniforms.u_time.value = t;
            const ptr = auroraUniforms.u_pointer.value;
            ptr.x += (pointerTarget.x - ptr.x) * 0.04;
            ptr.y += (pointerTarget.y - ptr.y) * 0.04;
            renderer.render(scene, camera);
            if (visible) raf = requestAnimationFrame(tick);
        };

        // Pause the loop while the hero is scrolled out of view.
        const io = new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            if (visible && !reduceMotion) {
                cancelAnimationFrame(raf);
                raf = requestAnimationFrame(tick);
            }
        });
        io.observe(host);

        if (reduceMotion) {
            auroraUniforms.u_time.value = 40; // a pleasant still frame
            dust.uniforms.u_time.value = 40;
            renderer.render(scene, camera);
        } else {
            raf = requestAnimationFrame(tick);
        }

        return () => {
            cancelAnimationFrame(raf);
            io.disconnect();
            observer.disconnect();
            window.removeEventListener('pointermove', onPointerMove);
            auroraGeometry.dispose();
            auroraMaterial.dispose();
            dust.geometry.dispose();
            dust.material.dispose();
            renderer.dispose();
            if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
        };
    }, []);

    return <div ref={hostRef} aria-hidden className="absolute inset-0 overflow-hidden [&>canvas]:h-full [&>canvas]:w-full" />;
}

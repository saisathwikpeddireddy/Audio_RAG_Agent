"use client";

// A soft, squishy blob that floats while idle, compresses during a search, and
// erupts in time with the highlight reel's frequency data. Purely decorative:
// it lives behind the UI and never captures pointer events.

import { Canvas, useFrame } from "@react-three/fiber";
import { Float, MeshDistortMaterial } from "@react-three/drei";
import { useRef } from "react";
import * as THREE from "three";

export type BlobMode = "idle" | "searching" | "playing";

const COLORS: Record<BlobMode, THREE.Color> = {
  idle: new THREE.Color("#ec4899"),
  searching: new THREE.Color("#06b6d4"),
  playing: new THREE.Color("#eab308"),
};

function Blob({ mode, analyser }: { mode: BlobMode; analyser: AnalyserNode | null }) {
  const mesh = useRef<THREE.Mesh>(null);
  const mat = useRef<any>(null);
  const bins = useRef<Uint8Array | null>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // Audio level 0..1 from the analyser (0 when not playing).
    let level = 0;
    if (analyser && mode === "playing") {
      if (!bins.current || bins.current.length !== analyser.frequencyBinCount) {
        bins.current = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(bins.current as any);
      let sum = 0;
      for (let i = 0; i < bins.current.length; i++) sum += bins.current[i];
      level = sum / bins.current.length / 255;
    }

    let distort = 0.3;
    let speed = 1.4;
    let scale = 1;
    if (mode === "searching") {
      distort = 0.08;
      speed = 0.8;
      scale = 0.78; // hold its breath
    } else if (mode === "playing") {
      distort = 0.35 + level * 1.1; // spike out when loud
      speed = 2 + level * 5;
      scale = 1 + level * 0.7;
    } else {
      distort = 0.3 + Math.sin(t * 1.2) * 0.05;
      speed = 1.3;
      scale = 1;
    }

    if (mat.current) {
      mat.current.distort = THREE.MathUtils.lerp(mat.current.distort ?? distort, distort, 0.18);
      mat.current.speed = speed;
      mat.current.color.lerp(COLORS[mode], 0.05);
    }
    if (mesh.current) {
      const s = THREE.MathUtils.lerp(mesh.current.scale.x, scale, 0.18);
      mesh.current.scale.setScalar(s);
      mesh.current.rotation.y = t * 0.15;
      mesh.current.rotation.x = t * 0.07;
    }
  });

  return (
    <Float speed={1.4} rotationIntensity={0.4} floatIntensity={0.8}>
      <mesh ref={mesh}>
        <sphereGeometry args={[1.5, 128, 128]} />
        <MeshDistortMaterial
          ref={mat}
          color={COLORS.idle}
          roughness={0.3}
          metalness={0.15}
          distort={0.3}
          speed={1.4}
        />
      </mesh>
    </Float>
  );
}

export default function ReactiveBlob({
  mode,
  analyser,
}: {
  mode: BlobMode;
  analyser: AnalyserNode | null;
}) {
  return (
    <div className="blob-wrap" aria-hidden>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ alpha: true, antialias: true }}
        camera={{ position: [0, 0, 4.2], fov: 45 }}
      >
        <ambientLight intensity={0.85} />
        <directionalLight position={[3, 4, 3]} intensity={1.3} />
        <directionalLight position={[-4, -2, -2]} intensity={0.5} color="#06b6d4" />
        <Blob mode={mode} analyser={analyser} />
      </Canvas>
    </div>
  );
}

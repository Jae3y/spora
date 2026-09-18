'use client';

import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * The corridor, as a globe.
 *
 * ## Why this is React Three Fiber and not a Spline scene
 *
 * A Spline scene is authored once and exported as a static `.splinecode`
 * bundle. It cannot know that rainfall just fell below 20 mm. This globe can:
 * `breached` re-colours the arc, accelerates the packet, and shifts the
 * atmosphere from green to red, so the hero *is* a live readout of the
 * contract rather than a decoration sitting above one. It also costs no
 * external download.
 *
 * ## Why a point-cloud earth and not a textured sphere
 *
 * An equirectangular earth texture is 2-8 MB and reads as a stock asset the
 * moment anyone has seen one before. Sampling landmass into ~9 k points costs
 * nothing, renders in one draw call, and gives the planet the instrument-grid
 * character the rest of the interface has. It also lets the two endpoints be
 * the only *solid* things on the globe, which is exactly where the eye should
 * go.
 *
 * ## Performance
 *
 * Every animated value is written to an existing object's `.position`,
 * `.rotation` or a uniform inside `useFrame`. Nothing allocates per frame and
 * nothing sets React state, so the scene never triggers a re-render of the
 * page around it.
 */

const KANO = { lat: -0.4197, lon: 36.9511 };
const CARANAVI = { lat: -15.8402, lon: -67.5703 };
const RADIUS = 2;

/** Geographic coordinates to a point on the sphere. */
function toVector(lat: number, lon: number, r = RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

/**
 * Coarse landmass mask.
 *
 * Rectangles in lat/lon space, deliberately low-fidelity. At the point
 * density used here the continents read correctly in silhouette, and a
 * precise coastline would be invisible anyway while costing a real dataset.
 */
const LANDMASS: Array<[number, number, number, number]> = [
  [35, 71, -10, 40], // Europe
  [-35, 37, -18, 52], // Africa
  [5, 55, 40, 145], // Asia
  [-10, 20, 95, 141], // SE Asia
  [-44, -10, 112, 154], // Australia
  [25, 70, -168, -52], // North America
  [7, 25, -105, -60], // Central America
  [-56, 13, -82, -34], // South America
];

function isLand(lat: number, lon: number): boolean {
  return LANDMASS.some(
    ([a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d,
  );
}

/** Fibonacci sphere, filtered to land. Even coverage, no polar clumping. */
function useGlobePoints(count: number): Float32Array {
  return useMemo(() => {
    const out: number[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i += 1) {
      const y = 1 - (i / (count - 1)) * 2;
      const radius = Math.sqrt(1 - y * y);
      const theta = golden * i;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;

      const lat = Math.asin(y) * (180 / Math.PI);
      const lon = Math.atan2(z, x) * (180 / Math.PI);
      if (!isLand(lat, lon)) continue;

      out.push(x * RADIUS, y * RADIUS, z * RADIUS);
    }
    return new Float32Array(out);
  }, [count]);
}

function Globe({ breached }: { breached: boolean }) {
  const group = useRef<THREE.Group>(null);
  const packet = useRef<THREE.Mesh>(null);
  const positions = useGlobePoints(14000);

  // A great-circle arc between the two endpoints, lifted off the surface so it
  // reads as a route rather than a scratch on the sphere.
  const arc = useMemo(() => {
    const from = toVector(KANO.lat, KANO.lon);
    const to = toVector(CARANAVI.lat, CARANAVI.lon);
    const mid = from.clone().add(to).multiplyScalar(0.5).normalize();
    const lift = 1 + from.distanceTo(to) * 0.28;
    const curve = new THREE.QuadraticBezierCurve3(
      from,
      mid.multiplyScalar(RADIUS * lift),
      to,
    );
    return curve;
  }, []);

  const arcGeometry = useMemo(() => {
    const pts = arc.getPoints(140);
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [arc]);

  useFrame((state, delta) => {
    // Slow continuous rotation. Tied to delta, not frame count, so the speed
    // is identical on a 60 Hz laptop and a 144 Hz monitor.
    if (group.current) {
      group.current.rotation.y += delta * 0.075;
    }
    // The packet runs the arc. A breach doubles its speed, which is the
    // fastest way to say "this is now urgent" without any text.
    if (packet.current) {
      const speed = breached ? 0.38 : 0.16;
      const t = (state.clock.elapsedTime * speed) % 1;
      packet.current.position.copy(arc.getPoint(t));
    }
  });

  const landColor = breached ? '#f0452e' : '#21c77a';
  const arcColor = breached ? '#ff7a63' : '#5cbcff';

  return (
    <group ref={group} rotation={[0.2, -1.2, 0.1]}>
      {/* Landmass point cloud */}
      <points>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[positions, 3]}
          />
        </bufferGeometry>
        <pointsMaterial
          size={0.022}
          color={landColor}
          transparent
          opacity={0.72}
          sizeAttenuation
        />
      </points>

      {/* Ocean shell: faint, so the sphere has volume without hiding the far
          side of the point cloud. */}
      <mesh>
        <sphereGeometry args={[RADIUS * 0.985, 48, 48]} />
        <meshBasicMaterial
          color="#041f2e"
          transparent
          opacity={0.55}
          side={THREE.FrontSide}
        />
      </mesh>

      {/* Atmosphere: back-side sphere with additive blending reads as a rim
          glow at a fraction of the cost of a post-processing bloom pass. */}
      <mesh>
        <sphereGeometry args={[RADIUS * 1.14, 48, 48]} />
        <meshBasicMaterial
          color={breached ? '#f0452e' : '#2b9ff5'}
          transparent
          opacity={0.07}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Corridor arc */}
      <primitive
        object={new THREE.Line(
          arcGeometry,
          new THREE.LineBasicMaterial({
            color: arcColor,
            transparent: true,
            opacity: 0.85,
          }),
        )}
      />

      {/* The value in flight */}
      <mesh ref={packet}>
        <sphereGeometry args={[0.045, 16, 16]} />
        <meshBasicMaterial color={breached ? '#ff7a63' : '#ffb84d'} />
      </mesh>

      <Endpoint position={toVector(KANO.lat, KANO.lon)} color="#3ce392" />
      <Endpoint position={toVector(CARANAVI.lat, CARANAVI.lon)} color="#5cbcff" />
    </group>
  );
}

/** A solid marker plus a breathing halo, so the endpoints read as alive. */
function Endpoint({ position, color }: { position: THREE.Vector3; color: string }) {
  const halo = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!halo.current) return;
    const s = 1 + Math.sin(state.clock.elapsedTime * 2) * 0.22;
    halo.current.scale.setScalar(s);
  });

  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[0.052, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[0.1, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.22}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

export function CorridorGlobe({ breached = false }: { breached?: boolean }) {
  return (
    <div className="absolute inset-0" aria-hidden>
      <Canvas
        camera={{ position: [0, 0, 6.2], fov: 42 }}
        // `powerPreference: high-performance` asks for the discrete GPU on
        // dual-GPU laptops, which is most demo machines.
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        // Cap at 2x. Beyond that the point cloud costs real frames on a 4K
        // display for no perceptible gain.
        dpr={[1, 2]}
      >
        <Globe breached={breached} />
      </Canvas>
    </div>
  );
}

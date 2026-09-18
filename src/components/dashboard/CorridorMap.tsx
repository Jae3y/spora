'use client';

import { Panel } from '@/components/ui/primitives';

/**
 * Cross-continental corridor visualisation.
 *
 * The geometry is an equirectangular projection of the two real endpoints --
 * Caranavi (-15.84, -67.57) and Kano (-0.42, 36.95) -- rather than hand-placed
 * dots, so the arc genuinely traces the South-America-to-East-Africa route the
 * shipment takes across the Atlantic.
 *
 * Flow direction is deliberately *westward* for capital and *eastward* for
 * goods: shillings pooled in Kano travel to Caranavi to buy biological inputs,
 * and those inputs ship back. Drawing a single bidirectional path would hide
 * the fact that the two legs settle on different rails and different days.
 */

export interface CorridorStage {
  id: string;
  label: string;
  rail: string;
}

/** Full-world projection space. Coordinates are computed against this... */
const WORLD_WIDTH = 900;
const WORLD_HEIGHT = 340;

/**
 * ...but the SVG is cropped to the corridor's actual bounding box.
 *
 * Both endpoints lie within 16° of the equator and span only 105° of
 * longitude, so a full-world viewBox would leave roughly 70% of the canvas
 * empty and shrink the route to a thin scratch in the middle. Projecting
 * against the world and *cropping* the viewport keeps the geography honest —
 * the arc is still a true equirectangular path between the real coordinates —
 * while giving the corridor the whole frame.
 */
const CROP = { x: 190, y: 62, width: 470, height: 196 } as const;

/**
 * Cross-fade for the amber→crimson escalation on a parametric breach.
 *
 * `stop-color` is an animatable SVG presentation attribute, so the gradient
 * can transition in place. Swapping the colour outright would read as a
 * different graphic appearing rather than as the same corridor escalating.
 */
const COLOR_SHIFT: React.CSSProperties = {
  transition: 'stop-color 400ms var(--ease-out)',
};

/** Equirectangular projection into world space. */
function project(lat: number, lon: number): { x: number; y: number } {
  return {
    x: ((lon + 180) / 360) * WORLD_WIDTH,
    y: ((90 - lat) / 180) * WORLD_HEIGHT,
  };
}

export function CorridorMap({
  stages,
  activeStageId,
  status,
  breached,
}: {
  stages: CorridorStage[];
  activeStageId: string;
  status: string;
  breached: boolean;
}) {
  const caranavi = project(-15.8402, -67.5703);
  const nyeri = project(-0.4197, 36.9511);

  // Lift the control point above the chord so the arc reads as a great-circle
  // route rather than a straight line through the ocean.
  const controlX = (caranavi.x + nyeri.x) / 2;
  const controlY = Math.min(caranavi.y, nyeri.y) - 78;
  const path = `M ${caranavi.x} ${caranavi.y} Q ${controlX} ${controlY} ${nyeri.x} ${nyeri.y}`;

  const flowColor = breached ? 'var(--drought)' : 'var(--amber)';
  const activeIndex = Math.max(
    0,
    stages.findIndex((s) => s.id === activeStageId),
  );

  return (
    <Panel
      title="Cross-continental corridor"
      subtitle="Kano, Nigeria to Caranavi and back. Capital west, biological inputs east."
      action={
        <span className={breached ? 'badge badge-breach' : 'badge badge-motion'}>
          {breached ? 'PARAMETRIC BREACH' : status.replace(/([a-z])([A-Z])/g, '$1 $2')}
        </span>
      }
    >
      <div className="panel-sunken overflow-hidden">
        <svg
          viewBox={`${CROP.x} ${CROP.y} ${CROP.width} ${CROP.height}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Corridor from Caranavi, Bolivia to Kano, Nigeria. Current status: ${status}.`}
        >
          <defs>
            <linearGradient id="corridor-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={flowColor} stopOpacity="0.15" style={COLOR_SHIFT} />
              <stop offset="50%" stopColor={flowColor} stopOpacity="0.9" style={COLOR_SHIFT} />
              <stop offset="100%" stopColor="var(--green)" stopOpacity="0.85" />
            </linearGradient>
            <radialGradient id="node-glow">
              <stop offset="0%" stopColor={flowColor} stopOpacity="0.55" style={COLOR_SHIFT} />
              <stop offset="100%" stopColor={flowColor} stopOpacity="0" style={COLOR_SHIFT} />
            </radialGradient>
          </defs>

          {/* Graticule at true 10° spacing: cheap geographic grounding
              without shipping a world-map raster. Drawn across the whole crop
              and clipped by the viewBox. */}
          <g opacity="0.16" stroke="var(--edge-bright)" strokeWidth="0.4">
            {Array.from({ length: 9 }, (_, i) => {
              const y = project(30 - i * 10, 0).y;
              return <line key={`h${i}`} x1={CROP.x} y1={y} x2={CROP.x + CROP.width} y2={y} />;
            })}
            {Array.from({ length: 13 }, (_, i) => {
              const x = project(0, -90 + i * 20).x;
              return <line key={`v${i}`} x1={x} y1={CROP.y} x2={x} y2={CROP.y + CROP.height} />;
            })}
          </g>

          {/* Equator, labelled — both endpoints sit within 16° of it, which is
              the actual reason this corridor shares a growing season. */}
          <line
            x1={CROP.x}
            y1={WORLD_HEIGHT / 2}
            x2={CROP.x + CROP.width}
            y2={WORLD_HEIGHT / 2}
            stroke="var(--edge-bright)"
            strokeWidth="0.75"
            strokeDasharray="2 6"
            opacity="0.55"
          />
          <text
            x={CROP.x + 6}
            y={WORLD_HEIGHT / 2 - 5}
            fill="var(--ink-dim)"
            fontSize="7"
            letterSpacing="1.5"
          >
            EQUATOR
          </text>

          {/* Static route, then the marching flow on top. The gradient stops
              cross-fade amber→crimson on a breach rather than cutting, so the
              corridor reads as *escalating* rather than as a different graphic
              having been swapped in. */}
          <path d={path} fill="none" stroke="var(--edge-bright)" strokeWidth="1.5" />
          <path
            d={path}
            fill="none"
            stroke="url(#corridor-grad)"
            strokeWidth="2.5"
            strokeLinecap="round"
            className={`corridor-flow ${breached ? 'corridor-flow-critical' : ''}`}
          />

          <Endpoint
            x={caranavi.x}
            y={caranavi.y}
            label="CARANAVI"
            sub="Bolivia · supplier"
            color={flowColor}
          />
          <Endpoint
            x={nyeri.x}
            y={nyeri.y}
            label="KANO"
            sub="Nigeria · cooperative"
            color="var(--green)"
          />
        </svg>
      </div>

      {/* Lifecycle rail */}
      <ol className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {stages.map((stage, index) => {
          const reached = index <= activeIndex;
          const current = index === activeIndex;
          return (
            <li
              key={stage.id}
              className={`panel-sunken px-3 py-2.5 transition-colors ${
                current ? 'ring-1 ring-[var(--amber)]' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    background: reached ? flowColor : 'var(--edge-bright)',
                  }}
                  aria-hidden
                />
                <span
                  className={`text-xs font-semibold ${
                    reached ? 'text-[var(--ink)]' : 'text-[var(--ink-dim)]'
                  }`}
                >
                  {stage.label}
                </span>
              </div>
              <div className="mt-1 pl-3.5 text-[0.6875rem] leading-tight text-[var(--ink-dim)]">
                {stage.rail}
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function Endpoint({
  x,
  y,
  label,
  sub,
  color,
}: {
  x: number;
  y: number;
  label: string;
  sub: string;
  color: string;
}) {
  // Keep labels inside the cropped viewport: a node near the right edge flips
  // its text to the left rather than running off-canvas.
  const anchor = x > CROP.x + CROP.width - 130 ? 'end' : 'start';
  const dx = anchor === 'end' ? -12 : 12;

  return (
    <g>
      <circle cx={x} cy={y} r="22" fill="url(#node-glow)" />
      <circle cx={x} cy={y} r="4.5" fill={color} />
      <circle cx={x} cy={y} r="8" fill="none" stroke={color} strokeWidth="0.9" opacity="0.55" />
      <text
        x={x + dx}
        y={y - 1}
        fill="var(--ink)"
        fontSize="10"
        fontWeight="600"
        letterSpacing="1.1"
        textAnchor={anchor}
      >
        {label}
      </text>
      <text
        x={x + dx}
        y={y + 10}
        fill="var(--ink-dim)"
        fontSize="7.5"
        textAnchor={anchor}
      >
        {sub}
      </text>
    </g>
  );
}

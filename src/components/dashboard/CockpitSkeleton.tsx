/**
 * First-paint skeleton, shaped like the cockpit it precedes.
 *
 * Deliberately not a spinner. The dashboard's real layout is a five-tile
 * treasury row over a wide corridor panel over two columns; rendering that
 * shape immediately means the page never reflows when data lands, and the
 * viewer has already parsed the structure by the time the numbers appear.
 *
 * It mirrors the real grid classes exactly. If the layout changes and this
 * does not, the mismatch shows up as a visible jump on every cold load, which
 * is the intended pressure to keep them in sync.
 */
export function CockpitSkeleton() {
  return (
    <main
      className="mx-auto max-w-[1600px] px-4 pb-24 pt-6 sm:px-6"
      aria-busy="true"
      aria-label="Loading corridor telemetry"
    >
      {/* header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="skeleton h-7 w-40" />
          <div className="skeleton h-4 w-[22rem] max-w-full" />
        </div>
        <div className="skeleton h-9 w-32 rounded-lg" />
      </div>

      {/* rail status */}
      <div className="mb-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="panel-sunken px-3 py-2.5">
            <div className="skeleton h-3.5 w-3/4" />
            <div className="skeleton mt-2 h-3 w-full" />
          </div>
        ))}
      </div>

      {/* treasury */}
      <div className="panel mb-6">
        <div className="panel-core p-5">
          <div className="skeleton h-3 w-32" />
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i}>
                <div className="skeleton h-3 w-24" />
                <div className={`skeleton mt-2 ${i === 0 ? 'h-9 w-36' : 'h-7 w-28'}`} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* corridor */}
      <div className="panel mb-6">
        <div className="panel-core p-5">
          <div className="skeleton h-3 w-44" />
          <div className="skeleton mt-4 aspect-[470/196] w-full rounded-xl" />
          <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="panel-sunken px-3 py-2.5">
                <div className="skeleton h-3 w-2/3" />
                <div className="skeleton mt-1.5 h-2.5 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* two-column body */}
      <div className="grid gap-6 xl:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="panel">
            <div className="panel-core space-y-4 p-5">
              <div className="skeleton h-3 w-40" />
              <div className="grid gap-4 sm:grid-cols-3">
                {Array.from({ length: 3 }, (_, j) => (
                  <div key={j}>
                    <div className="skeleton h-3 w-20" />
                    <div className="skeleton mt-2 h-6 w-24" />
                  </div>
                ))}
              </div>
              <div className="skeleton h-2 w-full rounded-full" />
              <div className="space-y-2">
                {Array.from({ length: 3 }, (_, j) => (
                  <div key={j} className="skeleton h-10 w-full" />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

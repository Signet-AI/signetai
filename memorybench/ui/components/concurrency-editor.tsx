"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import type { ConcurrencyConfig } from "@/lib/api"

const phases = ["ingest", "indexing", "search", "answer", "evaluate"] as const

type Phase = (typeof phases)[number]

type Props = {
  concurrency: ConcurrencyConfig
  onChange: (concurrency: ConcurrencyConfig) => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  description: string
  className?: string
}

export function ConcurrencyEditor({
  concurrency,
  onChange,
  expanded,
  onExpandedChange,
  description,
  className,
}: Props) {
  const [editingDefault, setEditingDefault] = useState(false)
  const [editingPhase, setEditingPhase] = useState<Phase | null>(null)
  const defaultInput = useRef<HTMLInputElement>(null)
  const phaseInputs = useRef(new Map<Phase, HTMLInputElement>())

  useEffect(() => {
    if (!editingDefault) return
    defaultInput.current?.focus()
    defaultInput.current?.select()
  }, [editingDefault])

  useEffect(() => {
    if (!editingPhase) return
    const input = phaseInputs.current.get(editingPhase)
    input?.focus()
    input?.select()
  }, [editingPhase])

  function updateDefault(value: string) {
    onChange({ ...concurrency, default: value ? Number.parseInt(value) : undefined })
  }

  function updatePhase(phase: Phase, value: string) {
    onChange({ ...concurrency, [phase]: value ? Number.parseInt(value) : undefined })
  }

  function closeOnKey(event: KeyboardEvent<HTMLInputElement>, close: () => void) {
    if (event.key === "Enter" || event.key === "Escape") close()
  }

  return (
    <div className={className}>
      <div className="flex items-center justify-between h-8">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">
            Concurrent requests{!expanded && ":"}
          </span>
          {!expanded &&
            (editingDefault ? (
              <input
                ref={defaultInput}
                type="number"
                className="w-16 px-2 py-0.5 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary focus:outline-none focus:border-accent"
                value={concurrency.default ?? ""}
                onChange={(event) => updateDefault(event.target.value)}
                onBlur={() => setEditingDefault(false)}
                onKeyDown={(event) => closeOnKey(event, () => setEditingDefault(false))}
                min="1"
              />
            ) : (
              <button
                type="button"
                className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer"
                onClick={() => setEditingDefault(true)}
              >
                <span className="font-medium">{concurrency.default ?? 1}</span>
                <EditIcon />
              </button>
            ))}
        </div>

        <button
          type="button"
          onClick={() => onExpandedChange(!expanded)}
          className="flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors"
        >
          <span>Advanced</span>
          <svg
            aria-hidden="true"
            className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {expanded && (
        <div className="mt-1 space-y-2">
          <p className="text-xs text-text-muted mb-2">{description}</p>
          {phases.map((phase) => (
            <div key={phase} className="flex items-center gap-3 h-7">
              <span className="text-sm text-text-secondary capitalize w-20">{phase}:</span>
              {editingPhase === phase ? (
                <input
                  ref={(input) => {
                    if (input) phaseInputs.current.set(phase, input)
                    else phaseInputs.current.delete(phase)
                  }}
                  type="number"
                  className="w-16 px-2 py-0.5 text-sm bg-[#222222] border border-[#444444] rounded text-text-primary focus:outline-none focus:border-accent"
                  value={concurrency[phase] ?? ""}
                  onChange={(event) => updatePhase(phase, event.target.value)}
                  onBlur={() => setEditingPhase(null)}
                  onKeyDown={(event) => closeOnKey(event, () => setEditingPhase(null))}
                  placeholder={String(concurrency.default ?? 1)}
                  min="1"
                />
              ) : (
                <button
                  type="button"
                  className="flex items-center gap-2 text-sm text-text-primary hover:text-accent transition-colors cursor-pointer"
                  onClick={() => setEditingPhase(phase)}
                >
                  <span
                    className={concurrency[phase] !== undefined ? "font-medium" : "text-text-muted"}
                  >
                    {concurrency[phase] ?? concurrency.default}
                  </span>
                  <EditIcon />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EditIcon() {
  return (
    <svg
      aria-hidden="true"
      className="w-3.5 h-3.5 text-text-muted"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
      />
    </svg>
  )
}

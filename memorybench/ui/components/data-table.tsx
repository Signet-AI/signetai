"use client"

import { ReactNode } from "react"
import { cn } from "@/lib/utils"

export interface Column<T> {
  key: string
  header: string
  render: (item: T, index: number) => ReactNode
  align?: "left" | "center" | "right"
  width?: string
  headerClassName?: string
  cellClassName?: string
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  onRowClick?: (item: T) => void
  emptyMessage?: string
  loading?: boolean
  getRowKey?: (item: T, index: number) => string | number
  connectToFilterBar?: boolean
}

export function DataTable<T>({
  columns,
  data,
  onRowClick,
  emptyMessage = "No data found",
  loading = false,
  getRowKey,
  connectToFilterBar = true,
}: DataTableProps<T>) {
  if (loading) {
    return (
      <div className="py-12 text-center border border-[#333333] rounded">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-text-secondary mt-3">Loading...</p>
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="py-12 text-center border border-[#333333] rounded">
        <p className="text-text-secondary">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "border border-[#333333] overflow-visible",
        connectToFilterBar ? "rounded-b border-t-0" : "rounded"
      )}
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-[#333333]">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "h-[44px] px-4 text-xs font-medium text-text-muted uppercase tracking-wider font-display",
                  col.align === "center" && "text-center",
                  col.align === "right" && "text-right",
                  !col.align && "text-left",
                  col.headerClassName
                )}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((item, idx) => (
            <tr
              key={getRowKey ? getRowKey(item, idx) : idx}
              className={cn(
                "h-[52px] border-b border-[#222222] last:border-0",
                onRowClick && "cursor-pointer hover:bg-[#1a1a1a] transition-colors"
              )}
              onClick={() => onRowClick?.(item)}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    "px-4 text-sm",
                    col.align === "center" && "text-center",
                    col.align === "right" && "text-right",
                    col.cellClassName
                  )}
                >
                  {col.render(item, idx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

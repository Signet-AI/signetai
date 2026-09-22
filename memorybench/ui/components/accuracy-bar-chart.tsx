"use client"
const PROVIDER_COLORS: Record<string, string> = {
  supermemory: "#4A9EF5",
}

const DEFAULT_COLORS = [
  "#F07167",
  "#F5B041",
  "#7DCEA0",
  "#BB8FCE",
  "#85C1E9",
]

interface AccuracyData {
  type: string
  values: { provider: string; accuracy: number | undefined }[]
}

interface AccuracyBarChartProps {
  data: AccuracyData[]
  providers: string[]
}

export function AccuracyBarChart({ data, providers }: AccuracyBarChartProps) {
  const colorMap = new Map<string, string>()
  let colorIndex = 0
  providers.forEach((provider) => {
    const lowerProvider = provider.toLowerCase()
    if (PROVIDER_COLORS[lowerProvider]) {
      colorMap.set(provider, PROVIDER_COLORS[lowerProvider])
    } else {
      colorMap.set(provider, DEFAULT_COLORS[colorIndex % DEFAULT_COLORS.length])
      colorIndex++
    }
  })

  const chartHeight = 280
  const barWidth = 24
  const barGap = 6
  const groupGap = 60
  const yAxisWidth = 35
  const xAxisHeight = 50
  const topPadding = 24
  const legendHeight = 32
  const groupWidth = providers.length * (barWidth + barGap) - barGap
  const yScale = (value: number) => {
    return chartHeight - (value / 100) * chartHeight
  }

  return (
    <div className="w-full h-full flex flex-col">
      {}
      <div className="flex flex-wrap gap-4 justify-end mb-2" style={{ minHeight: legendHeight }}>
        {providers.map((provider) => (
          <div key={provider} className="flex items-center gap-2">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: colorMap.get(provider) }} />
            <span className="text-xs text-text-secondary capitalize">{provider}</span>
          </div>
        ))}
      </div>

      {}
      <div className="flex-1 w-full">
        <svg
          width="100%"
          height={chartHeight + xAxisHeight + topPadding}
          viewBox={`0 0 ${yAxisWidth + data.length * (groupWidth + groupGap)} ${chartHeight + xAxisHeight + topPadding}`}
          preserveAspectRatio="xMidYMid meet"
          className="font-mono"
        >
          {}
          {[0, 20, 40, 60, 80, 100].map((value) => (
            <g key={value}>
              {}
              <text
                x={yAxisWidth - 8}
                y={yScale(value) + topPadding + 4}
                textAnchor="end"
                className="fill-text-muted"
                style={{ fontSize: 11 }}
              >
                {value}
              </text>
              {}
              <line
                x1={yAxisWidth}
                y1={yScale(value) + topPadding}
                x2={yAxisWidth + data.length * (groupWidth + groupGap) - groupGap + 20}
                y2={yScale(value) + topPadding}
                stroke="#333333"
                strokeDasharray="4 4"
                strokeWidth={1}
              />
            </g>
          ))}

          {}
          {data.map((category, categoryIndex) => {
            const groupX = yAxisWidth + categoryIndex * (groupWidth + groupGap) + groupGap / 2
            const accuracies = category.values.map((v) => v.accuracy ?? 0)
            const bestAccuracy = Math.max(...accuracies)
            const firstBestIndex = accuracies.findIndex((a) => a === bestAccuracy)

            return (
              <g key={category.type}>
                {}
                {category.values.map((item, providerIndex) => {
                  const barX = groupX + providerIndex * (barWidth + barGap)
                  const accuracyDecimal = item.accuracy ?? 0
                  const accuracyPercent = accuracyDecimal * 100
                  const barHeight = Math.max((accuracyPercent / 100) * chartHeight, 0)
                  const barY = yScale(accuracyPercent) + topPadding
                  const color = colorMap.get(item.provider) || DEFAULT_COLORS[0]
                  const isBest = providerIndex === firstBestIndex && bestAccuracy > 0
                  const radius = 6
                  const r = Math.min(radius, barWidth / 2, barHeight / 2)
                  const barPath =
                    barHeight > 0
                      ? `M ${barX} ${barY + barHeight}
                       L ${barX} ${barY + r}
                       Q ${barX} ${barY} ${barX + r} ${barY}
                       L ${barX + barWidth - r} ${barY}
                       Q ${barX + barWidth} ${barY} ${barX + barWidth} ${barY + r}
                       L ${barX + barWidth} ${barY + barHeight}
                       Z`
                      : ""

                  return (
                    <g key={item.provider}>
                      {}
                      {barHeight > 0 && (
                        <path
                          d={barPath}
                          fill={color}
                          style={isBest ? { filter: "brightness(1.15)" } : undefined}
                        />
                      )}
                      {}
                      {item.accuracy !== undefined && accuracyPercent > 0 && (
                        <text
                          x={barX + barWidth / 2}
                          y={barY - 6}
                          textAnchor="middle"
                          fill={isBest ? "#ffffff" : undefined}
                          className={isBest ? "" : "fill-text-secondary"}
                          style={{ fontSize: 9 }}
                        >
                          {accuracyPercent.toFixed(1)}%
                        </text>
                      )}
                    </g>
                  )
                })}

                {}
                <text
                  x={groupX + groupWidth / 2}
                  y={chartHeight + topPadding + 16}
                  textAnchor="middle"
                  className="fill-text-secondary"
                  style={{ fontSize: 10 }}
                >
                  {formatCategoryLabel(category.type)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

function formatCategoryLabel(type: string): string {
  return type
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

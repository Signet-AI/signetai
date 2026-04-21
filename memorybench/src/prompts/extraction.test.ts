import { describe, expect, it } from "bun:test"
import {
  boundStructuredContent,
  buildExtractionPrompt,
  buildStructuredPrompt,
  isAllowedStructuredEntityName,
  parseJson,
  sanitizeStructuredExtraction,
} from "./extraction"
import type { UnifiedSession } from "../types/unified"

describe("structured extraction prompts", () => {
  it("tells markdown extraction to preserve named services and recent usage", () => {
    const session: UnifiedSession = {
      sessionId: "service-usage",
      messages: [
        {
          role: "user",
          speaker: "Speaker A",
          content: "I've been listening to Arctic Monkeys on Spotify lately.",
        },
      ],
      metadata: { formattedDate: "2023/05/20 (Sat)" },
    }

    const prompt = buildExtractionPrompt(session)

    expect(prompt).toContain("streaming services")
    expect(prompt).toContain("using Spotify lately")
  })

  it("tells markdown extraction to preserve recurring schedule slots", () => {
    const session: UnifiedSession = {
      sessionId: "routine-schedule",
      messages: [
        {
          role: "user",
          speaker: "Speaker A",
          content:
            "I started yoga on Wednesdays. I also have Zumba on Tuesdays and Thursdays and weightlifting on Saturdays.",
        },
      ],
      metadata: { formattedDate: "2023/05/27 (Sat)" },
    }

    const prompt = buildExtractionPrompt(session)

    expect(prompt).toContain("recurring schedules and routines")
    expect(prompt).toContain("preserve every stated activity with its day")
    expect(prompt).toContain("write a separate fact for each recurring slot")
  })

  it("defines structured entities as durable referents with scoped user aspects", () => {
    const prompt = buildStructuredPrompt("Speaker A has been using Spotify lately.")

    expect(prompt).toContain("Entity: a durable referent")
    expect(prompt).toContain('map Speaker A, user, I, and me to the entity "Benchmark User"')
    expect(prompt).toContain("Generic personal preferences, routines, counts, and history belong")
    expect(prompt).toContain("Every attribute SHOULD include groupKey")
    expect(prompt).toContain("Every attribute MUST include claimKey")
    expect(prompt).toContain("korean_restaurants_tried_count")
    expect(prompt).toContain("For recurring schedules and routines")
    expect(prompt).toContain("class_schedule")
    expect(prompt).toContain("yoga_class_day")
  })

  it("bounds structured extraction content for local context windows", () => {
    const content = `${"Speaker A likes coffee.\n".repeat(1200)}Speaker A found 17 skeins of yarn.\n`
    const bounded = boundStructuredContent(content)
    const prompt = buildStructuredPrompt(content)

    expect(bounded.length).toBeLessThan(content.length)
    expect(bounded).toContain("Truncated")
    expect(bounded).toContain("middle characters")
    expect(bounded).toContain("17 skeins")
    expect(prompt).toContain(bounded)
  })
})

describe("structured extraction parser", () => {
  it("parses JSON wrapped in model chatter", () => {
    expect(
      parseJson(`I found the following structure:

\`\`\`json
{
  "entities": [],
  "aspects": [],
  "hints": ["What service was mentioned?"]
}
\`\`\`

Hope this helps.`)
    ).toEqual({
      entities: [],
      aspects: [],
      hints: ["What service was mentioned?"],
    })
  })
})

describe("structured extraction sanitizer", () => {
  it.each([
    ["Spotify", "system"],
    ["Spotify", "service"],
    ["Ferrari 288 GTO", "product"],
    ["Japanese Zero fighter plane", "project"],
    ["DHL Wellness Retreats", "organization"],
    ["The 1975", "work"],
    ["Wells Fargo Center", "place"],
    ["Ebooks.com", "system"],
    ["CT4L", "system"],
    ["Rachel", "person"],
    ["Speaker A", "person"],
    ["Speaker B", "person"],
    ["User", "person"],
    ["Assistant", "person"],
  ])("allows %s as a named entity", (name, type) => {
    expect(isAllowedStructuredEntityName(name, type)).toBe(true)
  })

  it.each([
    ["Speaker", "extracted"],
    ["Speaker A's mom", "person"],
    ["Speaker A's roommate", "person"],
    ["Upcoming Saturday/Sunday Speaker", "extracted"],
    ["speaker", "person"],
    ["Decisions", "extracted"],
    ["Plans", "extracted"],
    ["Decisions & Plans", "extracted"],
    ["Key Facts", "extracted"],
    ["None", "extracted"],
    ["Properties", "extracted"],
    ["project", "project"],
    ["friend", "person"],
    ["be", "unknown"],
    ["the", "unknown"],
    ["income inequality", "concept"],
    ["financial struggles", "concept"],
    ["Electric vehicles", "concept"],
    ["Mussels", "concept"],
    ["food truck", "concept"],
    ["road trip", "concept"],
    ["support group", "concept"],
    ["23 May 2023", "event"],
    ["April 2024", "event"],
  ])("rejects %s as a generic entity", (name, type) => {
    expect(isAllowedStructuredEntityName(name, type)).toBe(false)
  })

  it("normalizes benchmark participants while dropping truly generic entities", () => {
    const sanitized = sanitizeStructuredExtraction({
      entities: [
        {
          source: "Speaker A",
          sourceType: "person",
          relationship: "uses",
          target: "Spotify",
          targetType: "system",
          confidence: 0.95,
        },
        {
          source: "Spotify",
          sourceType: "system",
          relationship: "features",
          target: "The 1975",
          targetType: "work",
          confidence: 1.2,
        },
      ],
      aspects: [
        {
          entityName: "Speaker A",
          aspect: "preferences",
          attributes: [{ content: "Speaker A likes indie rock." }],
        },
        {
          entityName: "Spotify",
          aspect: "usage",
          attributes: [
            {
              content:
                "Speaker A has been listening to Arctic Monkeys and The Neighbourhood on Spotify lately.",
              groupKey: "listening habits",
              claimKey: "music_streaming_service_recent_usage",
              confidence: 0.9,
              importance: 0.8,
            },
          ],
        },
      ],
      hints: [
        "What music streaming service has Speaker A been using lately?",
        "What music streaming service has Speaker A been using lately?",
        "bad",
      ],
    })

    expect(sanitized.entities).toEqual([
      {
        source: "Benchmark User",
        sourceType: "person",
        relationship: "uses",
        target: "Spotify",
        targetType: "system",
        confidence: 0.95,
      },
      {
        source: "Spotify",
        sourceType: "system",
        relationship: "features",
        target: "The 1975",
        targetType: "work",
        confidence: 1,
      },
    ])
    expect(sanitized.aspects).toHaveLength(2)
    expect(sanitized.aspects[0]?.entityName).toBe("Benchmark User")
    expect(sanitized.aspects[0]?.attributes[0]?.groupKey).toBe("general")
    expect(sanitized.aspects[0]?.attributes[0]?.claimKey).toBe("speaker_a_likes_indie_rock")
    expect(sanitized.aspects[1]?.entityName).toBe("Spotify")
    expect(sanitized.aspects[1]?.attributes[0]?.groupKey).toBe("listening_habits")
    expect(sanitized.aspects[1]?.attributes[0]?.claimKey).toBe(
      "music_streaming_service_recent_usage"
    )
    expect(sanitized.hints).toEqual([
      "What music streaming service has Speaker A been using lately?",
    ])
  })
})

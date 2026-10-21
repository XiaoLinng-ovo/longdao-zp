import { resumeBodyCharacterCount, resumeTextHasEncodingDamage } from '../text-cleaning/index.js'

/** Minimal PDF.js text geometry; kept independent of the PDF runtime. */
export interface PositionedResumeText {
  str: string
  x: number
  y: number
  width: number
  height: number
  rotation?: number
}

function readRows(content: PositionedResumeText[]): string {
  const rows: { y: number; items: PositionedResumeText[] }[] = []
  for (const item of [...content].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1)
    const tolerance = Math.min(3, Math.max(1, item.height * 0.25))
    if (row && Math.abs(row.y - item.y) <= tolerance) row.items.push(item)
    else rows.push({ y: item.y, items: [item] })
  }
  return rows.map((row) => row.items.sort((a, b) => a.x - b.x).map((item, index, ordered) => {
    const previous = ordered[index - 1]
    const gap = previous ? item.x - previous.x - previous.width : 0
    return `${previous && gap > Math.max(2, item.height * 0.2) ? ' ' : ''}${item.str}`
  }).join('').trim()).join('\n')
}

const COLUMN_HEADING = /^(?:教育背景|教育经历|工作经历|实习经历|项目经历|项目经验|核心技能|专业技能|技能|荣誉与成果|校园经历|自我评价|education|experience|projects|skills|work experience|technical skills)$/iu

function readColumns(content: PositionedResumeText[]): string | undefined {
  const headings = content.filter((item) => COLUMN_HEADING.test(item.str.trim()
    .replace(/^[^\p{Script=Han}\p{N}]{1,4}\s+(?=\p{Script=Han})/u, '')
    .replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '')))
  // Independent section headings plus a sustained gutter distinguish columns
  // from ordinary key/value rows and right-aligned employment dates.
  for (const leftHeading of headings.sort((a, b) => a.y - b.y)) {
    for (const rightHeading of headings) {
      if (rightHeading.x - leftHeading.x < 100) continue
      const split = rightHeading.x - 1
      const start = Math.min(leftHeading.y, rightHeading.y) - 3
      const crossing = content.filter((item) => item.y >= start && item.x < split && item.x + item.width > split)
      const end = Math.min(...crossing.map((item) => item.y))
      const body = content.filter((item) => item.y >= start && item.y < end)
      const left = body.filter((item) => item.x < split)
      const right = body.filter((item) => item.x >= split)
      const substantial = (column: PositionedResumeText[]) => column.length >= 8
        && new Set(column.map((item) => Math.round(item.y / 4))).size >= 6
        && Math.max(...column.map((item) => item.y)) - start >= 100
        && column.map((item) => item.str).join('').length >= 80
        && column.filter((item) => /[\p{L}]{2}/u.test(item.str)).length >= 5
      if (!substantial(left) || !substantial(right)) continue
      const gutter = Math.min(...right.map((item) => item.x)) - Math.max(...left.map((item) => item.x + item.width))
      if (gutter < 12) continue
      return [readRows(content.filter((item) => item.y < start)), readRows(left), readRows(right),
        readRows(content.filter((item) => item.y >= end))].filter(Boolean).join('\n')
    }
  }
  return undefined
}

/** PDF drawing order is frequently different from the visible reading order. */
export function orderResumePdfPage(items: PositionedResumeText[]): string {
  // Filter repeated download watermarks before they can be merged into a real
  // sentence by layout reconstruction. A one-off identifier remains evidence.
  const identifiers = new Map<string, number>()
  for (const item of items) {
    const value = item.str.trim()
    if (/^[a-f0-9]{12,}[A-Za-z0-9_-]{20,}$/u.test(value) && /[A-Z]/u.test(value)) {
      identifiers.set(value, (identifiers.get(value) ?? 0) + 1)
    }
  }
  const watermarks = new Set([...identifiers].filter(([, count]) => count >= 2).map(([value]) => value))
  const diagonal = items.filter((item) => {
    const angle = Math.abs(item.rotation ?? 0) % Math.PI
    return angle > Math.PI / 8 && angle < Math.PI * 3 / 8 && item.str.trim().length >= 3
  })
  // Repeated diagonal text is a watermark family. Match clipped fragments
  // only with the same orientation and font size; horizontal body text stays.
  const diagonalWatermarks = diagonal.filter((item) => diagonal.filter((other) => other.str.trim() === item.str.trim()
    && Math.abs(other.height - item.height) < 1 && Math.abs((other.rotation ?? 0) - (item.rotation ?? 0)) < 0.02).length >= 3)
  const content = items.filter((item) => item.str.trim() && !watermarks.has(item.str.trim())
    && !diagonalWatermarks.some((watermark) => watermark.str.trim().includes(item.str.trim())
      && Math.abs(watermark.height - item.height) < 1 && Math.abs((watermark.rotation ?? 0) - (item.rotation ?? 0)) < 0.02)
    && !(watermarks.size && item.x < 0 && /^[ih]$/u.test(item.str.trim())))
  return readColumns(content) ?? readRows(content)
}

export interface ResumePdfImageRegion {
  x: number
  y: number
  width: number
  height: number
}

/** Interpret image placement only; PDF.js still owns all document decoding. */
export function resumePdfImageRegions(
  operators: { fnArray: number[]; argsArray: unknown[][] },
  ops: { save: number; restore: number; transform: number; paintImageXObject: number; paintInlineImageXObject: number; paintImageXObjectRepeat: number; paintInlineImageXObjectGroup: number;
    paintFormXObjectBegin?: number; paintFormXObjectEnd?: number; paintImageMaskXObject?: number; paintImageMaskXObjectRepeat?: number; paintImageMaskXObjectGroup?: number },
  viewportTransform: number[],
): ResumePdfImageRegion[] {
  const multiply = (a: number[], b: number[]) => [
    a[0]! * b[0]! + a[2]! * b[1]!, a[1]! * b[0]! + a[3]! * b[1]!,
    a[0]! * b[2]! + a[2]! * b[3]!, a[1]! * b[2]! + a[3]! * b[3]!,
    a[0]! * b[4]! + a[2]! * b[5]! + a[4]!, a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
  ]
  let matrix = [...viewportTransform]
  const stack: number[][] = []
  const regions: ResumePdfImageRegion[] = []
  const add = (transform = matrix) => {
    const xs = [transform[4]!, transform[0]! + transform[4]!, transform[2]! + transform[4]!, transform[0]! + transform[2]! + transform[4]!]
    const ys = [transform[5]!, transform[1]! + transform[5]!, transform[3]! + transform[5]!, transform[1]! + transform[3]! + transform[5]!]
    regions.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) })
  }
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index]
    const args = operators.argsArray[index] ?? []
    if (op === ops.save || op === ops.paintFormXObjectBegin) {
      stack.push([...matrix])
      if (op === ops.paintFormXObjectBegin && args[0]) matrix = multiply(matrix, args[0] as number[])
    }
    else if (op === ops.restore || op === ops.paintFormXObjectEnd) matrix = stack.pop() ?? [...viewportTransform]
    else if (op === ops.transform) matrix = multiply(matrix, args as number[])
    else if (op === ops.paintImageXObject || op === ops.paintInlineImageXObject || op === ops.paintImageMaskXObject) add()
    else if (op === ops.paintImageXObjectRepeat) {
      const positions = args[3] as ArrayLike<number>
      for (let i = 0; i < positions.length; i += 2) add(multiply(matrix, [args[1] as number, 0, 0, args[2] as number, positions[i]!, positions[i + 1]!]))
    } else if (op === ops.paintInlineImageXObjectGroup) {
      for (const entry of args[1] as { transform: number[] }[]) add(multiply(matrix, entry.transform))
    } else if (op === ops.paintImageMaskXObjectRepeat) {
      const positions = args[5] as ArrayLike<number>
      for (let i = 0; i < positions.length; i += 2) add(multiply(matrix, [args[1] as number, args[2] as number, args[3] as number, args[4] as number, positions[i]!, positions[i + 1]!]))
    } else if (op === ops.paintImageMaskXObjectGroup) {
      for (const entry of args[0] as { transform: number[] }[]) add(multiply(matrix, entry.transform))
    }
  }
  return regions
}

/** A readable header does not prove that a rasterized page body was extracted. */
export function resumePdfPageNeedsOcr(input: {
  text: string; items: PositionedResumeText[]; images: ResumePdfImageRegion[]; width: number; height: number
}): boolean {
  if (resumeTextHasEncodingDamage(input.text)) return true
  if (resumeBodyCharacterCount(input.text) < 20) return input.images.length > 0
  return input.images.some((image) => {
    const left = Math.max(0, image.x), top = Math.max(0, image.y)
    const right = Math.min(input.width, image.x + image.width), bottom = Math.min(input.height, image.y + image.height)
    const width = Math.max(0, right - left), height = Math.max(0, bottom - top)
    const fraction = width * height / (input.width * input.height)
    if (fraction < 0.18 || (fraction < 0.35 && width < input.width * 0.6)) return false
    const body = input.items.filter((item) => item.x + item.width / 2 >= left && item.x + item.width / 2 <= right
      && item.y >= top && item.y <= bottom && resumeBodyCharacterCount(item.str) > 0)
    const characters = resumeBodyCharacterCount(body.map((item) => item.str).join('\n'))
    const span = body.length ? Math.max(...body.map((item) => item.y)) - Math.min(...body.map((item) => item.y - item.height)) : 0
    return characters < 20 || (characters < 200 && span < height * 0.2)
  })
}

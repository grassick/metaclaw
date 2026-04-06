import { nanoid } from "nanoid"

const FILE_ID_PREFIX = "f_"
const FILE_ID_LENGTH = 8

export function generateFileId(): string {
  return FILE_ID_PREFIX + nanoid(FILE_ID_LENGTH)
}

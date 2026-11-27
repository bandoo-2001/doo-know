export const officeExtensions = ['docx', 'xlsx', 'pptx', 'pdf'] as const;
export type OfficeFormat = (typeof officeExtensions)[number];
export const officeLabels = { docx: 'Word', xlsx: 'Excel', pptx: 'PPT', pdf: 'PDF' } as const;
export function officeFormat(name: string): OfficeFormat | undefined {
  return /\.(docx|xlsx|pptx|pdf)$/i.exec(name)?.[1].toLowerCase() as OfficeFormat | undefined;
}

export type OfficeDocument = {
  id: string;
  name: string;
  fileType: OfficeFormat;
  /** Notebook originals have a path; older uploads keep their existing storage and links. */
  relativePath?: string;
  sizeBytes: number;
  updatedAt: string;
};

export type OfficeDocument = {
  id: string;
  name: string;
  fileType: 'docx' | 'xlsx' | 'pptx' | 'pdf';
  sizeBytes: number;
  updatedAt: string;
};

export const setupLocationMessages = {
  format: '请输入服务器上的完整文件夹路径，以 / 开头。也可以从文件夹列表选择。',
  base: '请选择允许范围内的子文件夹。当前选择的是保存范围的根目录。',
  outside: '该路径超出了允许的保存范围。请从下方范围内选择文件夹。',
  protected: '该位置包含应用或服务数据。请选择单独的资料文件夹。',
  missing: '找不到这个文件夹。请检查服务器上的路径，或选择已有文件夹。',
  file: '这个路径指向文件。请选择文件所在的文件夹。',
  link: '这个路径经过符号链接。请填写实际文件夹的完整路径。',
  hidden: '路径中包含隐藏目录。请选择可见的资料文件夹。',
  access: '服务账号无法读写这个文件夹。请选择有读写权限的位置。',
} as const;
export type SetupLocationIssue = keyof typeof setupLocationMessages;
export function validSetupPathFormat(input: unknown): input is string {
  return typeof input === 'string' && input.startsWith('/') && !/[\x00-\x1f\x7f]/.test(input);
}

/** These styles share the same card structure in the list and live preview. */
export const toDooAnniversaryThemes = [
  { value: 'bloom', label: '花间', description: '柔和花瓣，留住温暖的日子' },
  { value: 'landscape', label: '远山', description: '起伏山色，安静而舒展' },
  { value: 'orbit', label: '星轨', description: '环绕的轨迹，记录值得期待的时刻' },
  { value: 'minimal', label: '留白', description: '简洁边框，让日期成为主角' },
  { value: 'pixel', label: '像素', description: '方格与像素星星，带一点游戏的趣味' },
  { value: 'postcard', label: '明信片', description: '航空信纸与邮票，寄给未来的自己' },
  { value: 'paper', label: '手帐', description: '横线纸与纸胶带，收藏日常片段' },
  { value: 'night', label: '夜空', description: '深色星光，也适合安静的夜晚' },
  { value: 'photo', label: '照片', description: '上传自己的照片，选择喜欢的取景' },
] as const;

export const toDooAnniversaryPalettes = [
  { value: 'rose', label: '胭脂', color: '#b76478' },
  { value: 'sage', label: '青苔', color: '#608575' },
  { value: 'lavender', label: '暮紫', color: '#8670b0' },
  { value: 'amber', label: '暖杏', color: '#ac7b3c' },
  { value: 'ocean', label: '雾蓝', color: '#5289ab' },
] as const;

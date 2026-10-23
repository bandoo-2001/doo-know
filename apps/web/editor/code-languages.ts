import type { Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export const codeLanguages = [
  { name: '纯文本', value: '' },
  ...languages.map(language => ({
    name: language.name,
    value: language.alias.find(alias => /^[a-z0-9_+#.-]+$/i.test(alias)) ||
      language.name.toLowerCase().replace(/[^a-z0-9_+#.-]/g, '-'),
  })).sort((a, b) => a.name.localeCompare(b.name)),
];

// The catalogue is cheap; each parser remains in its own asynchronously loaded chunk.
export async function loadCodeLanguage(name: string): Promise<Extension> {
  const language = LanguageDescription.matchLanguageName(languages, name.trim(), false);
  if (!language) return [];
  try {
    return await language.load();
  } catch {
    return [];
  }
}

import type { BlogMetadata } from './blog-contracts.js';

export type BlogTemplate = 'journal' | 'magazine' | 'profile';
export type BlogLink = { id: string; label: string; href: string };
export type BlogHomeModuleKind =
  | 'intro'
  | 'featured'
  | 'latest'
  | 'collections'
  | 'projects'
  | 'links';
export type BlogHomeModule = {
  id: string;
  kind: BlogHomeModuleKind;
  title: string;
  enabled: boolean;
  limit: number;
};
export type BlogCollection = {
  id: string;
  slug: string;
  title: string;
  description: string;
  postIds: string[];
};
export type BlogProject = { id: string; title: string; description: string; href: string };
export type BlogDesign = {
  template: BlogTemplate;
  accent: string;
  font: 'sans' | 'serif';
  width: 'comfortable' | 'wide';
  cardStyle: 'plain' | 'bordered';
  profile: { name: string; tagline: string; bio: string; avatar: string; cover: string };
  navigation: BlogLink[];
  socialLinks: BlogLink[];
  modules: BlogHomeModule[];
  collections: BlogCollection[];
  projects: BlogProject[];
  friendLinks: BlogLink[];
};
export type BlogDesignRevision = { revision: number; publishedAt: string };
export type BlogDesignState = {
  version: number;
  draft: BlogDesign;
  published: BlogDesign;
  publishedRevision: number;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
  history: BlogDesignRevision[];
};
export type BlogSaveDesignInput = {
  design: BlogDesign;
  expectedVersion: number;
  requestId: string;
};
export type BlogPublishDesignInput = { expectedVersion: number; requestId: string };
export type BlogRestoreDesignInput = BlogPublishDesignInput & { revision: number };
export type BlogDesignMedia = {
  hash: string;
  mime: string;
  url: string;
  previewUrl: string;
  size: number;
};
export type BlogPublicPostSummary = BlogMetadata & {
  id: string;
  publishedAt: string;
  updatedAt: string;
  url: string;
};
export type BlogPublicQuery = {
  query?: string;
  category?: string;
  tag?: string;
  page?: number;
  pageSize?: number;
  postIds?: string[];
};
export type BlogPublicPage = {
  posts: BlogPublicPostSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
export type BlogPublicTaxonomy = {
  categories: { name: string; count: number }[];
  tags: { name: string; count: number }[];
};
export type BlogPublicationWarning = {
  code: 'unpublished-link' | 'missing-link' | 'missing-image' | 'unsupported-image';
  target: string;
  message: string;
};
export type BlogPublicationReview = {
  publishedHtml: string | null;
  draftHtml: string;
  warnings: BlogPublicationWarning[];
  affectedPosts: { id: string; title: string; url: string }[];
};

export function defaultBlogDesign(): BlogDesign {
  return {
    template: 'journal',
    accent: '#44684f',
    font: 'sans',
    width: 'comfortable',
    cardStyle: 'plain',
    profile: { name: '', tagline: '', bio: '', avatar: '', cover: '' },
    navigation: [
      { id: 'articles', label: '文章', href: '/blog/-/articles' },
      { id: 'collections', label: '专题', href: '/blog/-/collections' },
      { id: 'archive', label: '归档', href: '/blog/archive' },
      { id: 'about', label: '关于', href: '/blog/about' },
    ],
    socialLinks: [],
    modules: [
      { id: 'intro', kind: 'intro', title: '关于我', enabled: true, limit: 1 },
      { id: 'featured', kind: 'featured', title: '精选文章', enabled: true, limit: 3 },
      { id: 'latest', kind: 'latest', title: '最近更新', enabled: true, limit: 6 },
      { id: 'collections', kind: 'collections', title: '专题合集', enabled: true, limit: 6 },
      { id: 'projects', kind: 'projects', title: '我的项目', enabled: true, limit: 6 },
      { id: 'links', kind: 'links', title: '友情链接', enabled: true, limit: 12 },
    ],
    collections: [],
    projects: [],
    friendLinks: [],
  };
}

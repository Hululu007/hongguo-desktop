/**
 * 渲染层数据模型。
 * 字段由主进程从 @hongguo/data-server（demo 协议方案）适配填充：
 * 列表卡片来自 App 端目录/搜索协议，详情来自官网 HTML 解析（_ROUTER_DATA）。
 */

/** 列表卡片（App 端目录/搜索协议字段映射） */
export interface DramaCard {
  id: string;
  title: string;
  coverUrl: string;
  totalEpisodes?: number | null;
  tags: string[];
  /** 一句话简介（demo 卡片 2 行截断展示） */
  description?: string;
  /** 运营角标文案（演员作品接口返回，如"全网热播"） */
  recText?: string;
  kind?: 'drama' | 'comic';
}

/** 榜单条目：卡片 + 可选热度指标（demo 目录协议未提供热度时缺省） */
export interface RankItem extends DramaCard {
  rank?: number;
  episodeCount?: number;
  categories?: string[];
  description?: string;
  heatValue?: number;
  heatText?: string;
  score?: string;
  scoreValue?: number;
  favoriteValue?: number;
  favoriteText?: string;
  likeValue?: number;
  likeText?: string;
}

/** 分集（官网 player 页 _ROUTER_DATA/vid_list 映射，vid 即 App 端播放/流端点编号） */
export interface Episode {
  id?: string;
  index: number;
  title: string;
  locked?: boolean;
  playPath?: string;
}

/** 演员条目（官网演员信息 / App 端演员协议映射） */
export interface ActorRef {
  id: string;
  name: string;
  role?: string;
  avatarUrl?: string;
}

export interface Review {
  author: string;
  authorAvatarUrl?: string;
  publishedAt?: string;
  rating?: number;
  content: string;
  likes?: number;
}

/** 剧集详情（官网详情页：social_info.热度/评分、celebrities、分集列表） */
export interface DramaDetail {
  id: string;
  title: string;
  coverUrl: string;
  backgroundImage?: string;
  rankInfo?: { label: string; rank: number; path: string } | null;
  heatValue?: number;
  rating?: string;
  ratingValue?: number;
  likeValue?: number;
  favoriteValue?: number;
  totalEpisodes?: number | null;
  status?: 'completed' | 'updating';
  orientation?: 'horizontal' | 'vertical';
  accessibleEpisodeCount?: number;
  tags: string[];
  category: string[];
  description?: string;
  actors: ActorRef[];
  episodes: Episode[];
  reviews: Review[];
  reviewTotal?: number;
  recommendations: DramaCard[];
  hotRecommendations: DramaCard[];
}

export interface HomeSection {
  name: string;
  moreUrl?: string;
  items: DramaCard[];
}

export interface CategorySub {
  key: string;
  label: string;
}

export interface CategoryPageResult {
  items: DramaCard[];
  subs: CategorySub[];
  hasMore?: boolean;
}

export interface RankTab {
  key: string;
  label: string;
}

export interface RankPageResult {
  items: RankItem[];
  tabs: RankTab[];
  hasMore?: boolean;
}

export interface SearchSuggestion {
  kind: 'drama' | 'keyword';
  keyword: string;
  name: string;
  coverUrl?: string;
  totalEpisodes?: number;
  heatText?: string;
  categories?: string[];
}

export interface SearchResultPage {
  /** 搜索结果条目：含简介/分类标签/集数，供榜单行式（RankList）展示 */
  items: RankItem[];
  totalCount?: number;
  hasMore: boolean;
}

/** 榜单名次变化（App 端演员协议 rank_change 映射；1=升 2=降 3=平/新上榜） */
export interface RankChange {
  type: number;
  num: number;
}

/** 剧星榜演员条目（App 端演员协议映射） */
export interface ActorCard {
  id: string;
  name: string;
  avatarUrl?: string;
  rank?: number;
  /** 人气文案，如 "1053万人气" */
  score?: string;
  /** 榜单副标题，如 "54部作品"、"双周追剧656万人" */
  subTitles?: string[];
  /** 较上期名次变化 */
  rankChange?: RankChange;
  intro?: string;
}

export interface ActorDetail {
  id: string;
  name: string;
  avatarUrl?: string;
  intro?: string;
  related: ActorCard[];
}

export interface ActorWorksPage {
  items: DramaCard[];
  hasMore: boolean;
  total: number;
}

// ===== 账号（官网扫码登录 + 云同步） =====

/** 当前登录用户资料（来自 /reading/user/info/v1/） */
export interface AccountUser {
  /** 用户 id（biz_user_id / user_id_str） */
  userId: string;
  /** 昵称（name / screen_name） */
  name: string;
  /** 头像 URL（可空，空时渲染层用占位图标） */
  avatar?: string;
}

/** 账号登录态概览（account.status） */
export interface AccountStatus {
  loggedIn: boolean;
  user: AccountUser | null;
  /** 登录态保存时间戳（毫秒，未登录为 null） */
  savedAt: number | null;
}

/** 扫码会话（account.loginStart 返回） */
export interface QrLoginSession {
  /** 轮询凭据 token（check_qrconnect 用） */
  token: string;
  /** 二维码 data URI（PNG） */
  qrcode: string;
  /** 有效期秒数（服务端给多少算多少，缺省 60） */
  expiresInSec: number;
}

/** 扫码轮询状态：pending 等待 / scanned 已扫 / confirmed 确认 / expired 过期 / canceled 取消 */
export type QrLoginPollResult = {
  status: 'pending' | 'scanned' | 'confirmed' | 'expired' | 'canceled';
  user?: AccountUser;
};

/** 云端播放进度行（read_progress/list/v1/ 映射后） */
export interface CloudProgressRow {
  seriesId: string;
  vid: string;
  seriesTitle: string;
  /** 1 起的分集序号 */
  vidIndex: number;
  episodeCnt?: number;
  /** 当前播放位置（毫秒） */
  positionMs: number;
  /** 当前分集总时长（毫秒） */
  durationMs?: number;
  /** 最后观看时间戳（毫秒） */
  lastWatchTime: number;
  /** 封面（多详情补齐，可空） */
  coverUrl?: string;
}

/** 云端收藏行（bookshelf/video/info/v1/ 映射后） */
export interface CloudFavoriteRow {
  seriesId: string;
  title: string;
  coverUrl?: string;
  episodeCnt?: number;
  /** 收藏时间戳（毫秒） */
  favoritedAt: number;
}

/** 进度上报入参（秒入参，服务端 ×1000 转 ms；title 仅服务端日志用） */
export interface ProgressReportInput {
  seriesId: string;
  vid: string;
  /** 1 起的分集序号 */
  episodeIndex: number;
  positionSec: number;
  durationSec?: number;
  episodeCount?: number;
  title?: string;
}

/** 分类页主导航（demo App 端目录协议支持的分类；漫画能力已随旧 scraper 废弃） */
export const CATEGORY_MAINS: { key: string; label: string }[] = [
  { key: 'real-drama', label: '真人剧' },
  { key: 'comic-drama', label: '漫剧' },
  { key: 'ai-drama', label: 'AI剧' },
];

/** 榜单页页签（App 端榜单目录分类） */
export const RANK_TABS: RankTab[] = [
  { key: 'hot-drama', label: '热播榜' },
  { key: 'hot-real-drama', label: '真人剧榜' },
  { key: 'hot-comic-drama', label: '漫剧榜' },
  { key: 'hot-ai-drama', label: 'AI剧榜' },
];

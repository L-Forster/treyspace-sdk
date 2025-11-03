/**
 * Cluster Service - Semantic Cluster Management
 *
 * Handles retrieval and description generation for canvas semantic clusters.
 * Clusters are organized by Helix into three types:
 * - Relational: Connected components in the graph
 * - Semantic: Semantically similar elements
 * - Distance: Spatially proximate elements
 *
 * Generates human-readable descriptions using LLM and caches them for performance.
 */

import crypto from "node:crypto";

import { buildAuthHeadersFromReq, getProxyBaseFromReq, type RequestLike } from "./util.js";

// Caching and preview configuration
const DESC_CACHE_MAX = 5_000;
const CACHE_TTL_MS = 10 * 60_000; // 10 minutes
const MAX_TEXT_PREVIEW = 100;
const MAX_MEMBER_PREVIEW = 60;
const MAX_PREVIEW_MEMBERS = 2;

type ClusterKind = "relational" | "semantic" | "distance";

interface BaseCluster {
  id?: string;
  cluster_id?: string;
  member_count?: number;
  members?: Array<{ externalId?: string; kind?: string; text?: string }>;
  memberIds?: string[];
  description?: string;
  element_type_counts?: Record<string, number>;
  all_text_content?: string;
}

interface ClusterData {
  relational_clusters?: BaseCluster[];
  semantic_clusters?: BaseCluster[];
  distance_clusters?: BaseCluster[];
  [key: string]: unknown;
}

interface ClusterCacheEntry {
  desc: string;
  ts: number;
}

const descriptionCache = new Map<string, ClusterCacheEntry>();

const setCache = (key: string, value: ClusterCacheEntry) => {
  if (descriptionCache.has(key)) descriptionCache.delete(key);
  descriptionCache.set(key, value);
  if (descriptionCache.size > DESC_CACHE_MAX) {
    const iterator = descriptionCache.keys().next();
    if (!iterator.done) {
      descriptionCache.delete(iterator.value);
    }
  }
};

const getCache = (key: string) => {
  const entry = descriptionCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    descriptionCache.delete(key);
    return undefined;
  }
  descriptionCache.delete(key);
  descriptionCache.set(key, entry);
  return entry;
};

/**
 * Creates SHA-256 hash of a string for cache keys
 *
 * @param value - String to hash
 * @returns Hex-encoded hash
 */
const hash = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Infers cluster type from its ID prefix
 *
 * @param cluster - Cluster object
 * @returns Cluster type (relational, semantic, or distance)
 *
 * Cluster IDs use prefixes: r_ (relational), s_ (semantic), d_ (distance)
 */
const inferKind = (cluster: BaseCluster): ClusterKind => {
  const id = cluster.id || cluster.cluster_id || "";
  if (id.startsWith("r_")) return "relational";
  if (id.startsWith("s_")) return "semantic";
  return "distance";
};

/**
 * Gets the number of members in a cluster
 *
 * @param cluster - Cluster object
 * @returns Member count
 *
 * Checks multiple possible fields for member count.
 */
const memberCount = (cluster: BaseCluster): number => {
  if (typeof cluster.member_count === "number") return cluster.member_count;
  if (Array.isArray(cluster.members)) return cluster.members.length;
  if (Array.isArray(cluster.memberIds)) return cluster.memberIds.length;
  return 0;
};

/**
 * Backend Cluster Service
 *
 * Manages semantic clusters for canvas boards.
 * Retrieves clusters from Helix and generates human-readable descriptions.
 */
export class BackendClusterService {
  private readonly req: RequestLike;
  private readonly boardId?: string;
  private readonly proxyBase: string;

  constructor(req: RequestLike, boardId?: string) {
    this.req = req;
    this.boardId = boardId;
    this.proxyBase = getProxyBaseFromReq(req);
  }

  /**
   * Retrieves clusters for a canvas board
   *
   * @returns Cluster data with relational, semantic, and distance clusters
   *
   * Proxies to SDK façade /api/clusters endpoint.
   * Returns error object if board ID missing or fetch fails.
   */
  async getCanvasClusters(): Promise<ClusterData> {
    if (!this.boardId) {
      return { error: "Board ID is not available." } as unknown as ClusterData;
    }
    try {
      const headers = buildAuthHeadersFromReq(this.req, true);
      const url = `${this.proxyBase}/api/clusters`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ boardId: this.boardId }),
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch clusters: ${response.statusText}`);
      }
      const data = await response.json();
      return data as ClusterData;
    } catch (error) {
      const message = (error as Error).message;
      console.error("[BackendClusterService] Failed to query clusters", message, error);
      return { error: message } as unknown as ClusterData;
    }
  }

  /**
   * Generates human-readable descriptions for all clusters
   *
   * @param clusterData - Cluster data object
   * @param onEvent - Optional status callback
   * @returns Cluster data with description fields populated
   *
   * Uses caching to avoid regenerating descriptions.
   * Creates descriptions from element text content and metadata.
   */
  async generateClusterDescriptions(clusterData: ClusterData, onEvent?: (status: string) => void) {
    const relational = Array.isArray(clusterData?.relational_clusters)
      ? clusterData.relational_clusters
      : [];
    const semantic = Array.isArray(clusterData?.semantic_clusters)
      ? clusterData.semantic_clusters
      : [];
    const distance = Array.isArray(clusterData?.distance_clusters)
      ? clusterData.distance_clusters
      : [];
    const total = relational.length + semantic.length + distance.length;
    if (total === 0) return clusterData;

    const describe = (cluster: BaseCluster) => {
      const type = inferKind(cluster);
      const count = memberCount(cluster);
      const signature = hash(
        JSON.stringify({ type, count, text: cluster.all_text_content || cluster.members })
      );
      const cached = getCache(signature);
      if (cached) return cached.desc;

      let text = "";
      if (typeof cluster.all_text_content === "string" && cluster.all_text_content.trim()) {
        text = cluster.all_text_content.trim().slice(0, MAX_TEXT_PREVIEW);
      } else if (Array.isArray(cluster.members)) {
        const snippets: string[] = [];
        for (const member of cluster.members) {
          const snippet = typeof member?.text === "string" ? member.text.trim() : "";
          if (snippet) snippets.push(snippet.slice(0, MAX_MEMBER_PREVIEW));
          if (snippets.length >= MAX_PREVIEW_MEMBERS) break;
        }
        text = snippets.join(", ");
      }

      let desc = `${type} cluster`;
      if (count > 1) desc += ` (${count} elements)`;
      if (text) desc += `: ${text}${text.length >= MAX_TEXT_PREVIEW ? "..." : ""}`;
      setCache(signature, { desc, ts: Date.now() });
      return desc;
    };

    const fillDescriptions = (clusters: BaseCluster[]) => {
      for (const cluster of clusters) {
        if (!cluster.description) {
          cluster.description = describe(cluster);
        }
      }
    };

    try {
      fillDescriptions(relational);
      fillDescriptions(semantic);
      fillDescriptions(distance);
      onEvent?.("Analyzing canvas content...");
      return clusterData;
    } catch (error) {
      console.error("[BackendClusterService] Description generation error", error);
      [...relational, ...semantic, ...distance].forEach((cluster) => {
        cluster.description = `Cluster with ${memberCount(cluster)} elements`;
      });
      return clusterData;
    }
  }

  /**
   * Creates a formatted summary of all clusters
   *
   * @param clusterData - Cluster data object
   * @returns Multi-line string with cluster overview
   *
   * Generates a text summary showing:
   * - Total element count
   * - Cluster counts by type
   * - Individual cluster details with IDs, descriptions, and element types
   */
  summarizeCluster(clusterData: ClusterData) {
    try {
      const sections: string[] = [];
      const allClusters = [
        ...(clusterData?.relational_clusters || []),
        ...(clusterData?.semantic_clusters || []),
        ...(clusterData?.distance_clusters || []),
      ];
      const totalElements = allClusters.reduce((sum, cluster) => sum + memberCount(cluster), 0);
      sections.push("CANVAS OVERVIEW:");
      sections.push(`Total Elements: ${totalElements}`);
      sections.push(
        `Total Clusters: ${allClusters.length} (${clusterData?.relational_clusters?.length || 0} relational, ${clusterData?.semantic_clusters?.length || 0} semantic, ${clusterData?.distance_clusters?.length || 0} spatial)`
      );
      sections.push("");

      const renderClusterSection = (label: string, clusters: BaseCluster[]) => {
        if (!clusters.length) return;
        sections.push(`${label.toUpperCase()} (${clusters.length}):`);
        clusters.forEach((cluster, index) => {
          const id = cluster.id || cluster.cluster_id || `cluster_${index + 1}`;
          sections.push(`  ${index + 1}. ID: ${id} (${memberCount(cluster)} elements)`);
          if (cluster.description) sections.push(`     Description: ${cluster.description}`);
          const counts = cluster.element_type_counts;
          if (counts && Object.keys(counts).length > 0) {
            const detail = Object.entries(counts)
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([key, value]) => `${key}: ${value}`)
              .join(", ");
            sections.push(`     Element Types: ${detail}`);
          }
        });
        sections.push("");
      };

      renderClusterSection("Relational clusters", clusterData.relational_clusters || []);
      renderClusterSection("Semantic clusters", clusterData.semantic_clusters || []);
      renderClusterSection("Distance clusters", clusterData.distance_clusters || []);

      return sections.join("\n");
    } catch (error) {
      console.error("[BackendClusterService] summarizeCluster error", error);
      return "Unable to summarize clusters.";
    }
  }
}

/**
 * Helper utilities for ID extraction and normalization
 * Consolidates repetitive ID extraction patterns used throughout the codebase
 */

/**
 * Extracts ID from an object by checking multiple possible field names
 * @param entry - Object potentially containing an ID
 * @param fields - Array of field names to check in order
 * @returns Extracted ID or empty string
 */
export const extractId = (
  entry: unknown,
  fields: string[] = ['externalId', 'external_id', 'elementId', 'element_id', 'id']
): string => {
  if (!entry || typeof entry !== 'object') return '';

  for (const field of fields) {
    const value = (entry as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

/**
 * Extracts multiple IDs from an array of entries
 * Handles both string arrays and object arrays
 * @param candidates - Array of strings or objects containing IDs
 * @param fields - Field names to check for objects
 * @returns Array of extracted IDs
 */
export const extractIds = (
  candidates: unknown,
  fields?: string[]
): string[] => {
  if (!Array.isArray(candidates)) return [];

  return candidates
    .map((entry) => {
      // Handle string arrays directly
      if (typeof entry === 'string') return entry.trim();
      // Handle object arrays with ID extraction
      if (entry && typeof entry === 'object') {
        return extractId(entry, fields);
      }
      return '';
    })
    .filter((value) => typeof value === 'string' && value.length > 0);
};

/**
 * Extracts cluster ID from an object checking multiple field names
 * @param cluster - Cluster object
 * @returns Cluster ID or empty string
 */
export const extractClusterId = (cluster: unknown): string => {
  return extractId(cluster, ['cluster_id', 'clusterId', 'clusterID', 'id', 'cluster.id']);
};

/**
 * Finds a cluster by ID from an array, checking multiple ID field variations
 * @param clusters - Array of cluster objects
 * @param targetId - ID to search for
 * @returns Found cluster or undefined
 */
export const findClusterById = (clusters: unknown[], targetId: string): unknown => {
  if (!Array.isArray(clusters) || !targetId) return undefined;

  return clusters.find((cluster) => {
    const clusterId = extractClusterId(cluster);
    return clusterId === targetId;
  });
};

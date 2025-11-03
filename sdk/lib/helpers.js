/**
 * Common helper utilities for ID extraction and normalization
 */

/**
 * Extracts ID from an object by checking multiple possible field names
 * @param {Object} entry - Object potentially containing an ID
 * @param {Array<string>} fields - Array of field names to check in order
 * @returns {string} Extracted ID or empty string
 */
export const extractId = (entry, fields = ['externalId', 'external_id', 'elementId', 'element_id', 'id']) => {
  if (!entry || typeof entry !== 'object') return '';

  for (const field of fields) {
    const value = entry[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

/**
 * Extracts multiple IDs from an array of entries
 * @param {Array} entries - Array of objects containing IDs
 * @param {Array<string>} fields - Field names to check
 * @returns {Array<string>} Array of extracted IDs
 */
export const extractIds = (entries, fields) => {
  if (!Array.isArray(entries)) return [];

  return entries
    .map(entry => extractId(entry, fields))
    .filter(id => id.length > 0);
};

/**
 * Extracts cluster ID from an object checking multiple field names
 * @param {Object} cluster - Cluster object
 * @returns {string} Cluster ID or empty string
 */
export const extractClusterId = (cluster) => {
  return extractId(cluster, ['cluster_id', 'clusterId', 'clusterID', 'id']);
};

/**
 * Constants for common time durations
 */
export const TIME_CONSTANTS = {
  ONE_SECOND: 1_000,
  ONE_MINUTE: 60_000,
  FIVE_MINUTES: 5 * 60_000,
  TEN_MINUTES: 10 * 60_000,
  ONE_HOUR: 60 * 60_000,
  ONE_DAY: 24 * 60 * 60_000,
};

/**
 * Constants for clustering algorithms
 */
export const CLUSTER_CONSTANTS = {
  CACHE_TTL: TIME_CONSTANTS.FIVE_MINUTES,
  MAX_ITERS: 20_000,
  CELL_SIZE: 300,
  MAX_DISTANCE: 300,
  DISTANCE_THRESHOLD: 1.0,
  SEMANTIC_SIMILARITY_THRESHOLD: 0.75,
  MAX_EMBED_CONCURRENCY: 4,
};

/**
 * Constants for element limits and sizes
 */
export const ELEMENT_CONSTANTS = {
  MAX_TEXT_PREVIEW: 100,
  MAX_MEMBER_PREVIEW: 60,
  MAX_PREVIEW_MEMBERS: 2,
  DESC_CACHE_MAX: 5_000,
  MAX_ELEMENTS_PER_SYNC: 1500,
  MAX_PAYLOAD_BYTES: 10 * 1024 * 1024, // 10MB
};

/**
 * Constants for spatial relationships
 */
export const SPATIAL_CONSTANTS = {
  NEAR_DISTANCE: 300, // Distance threshold for "near" relationships
  DIRECTIONAL_GAP: 100, // Max gap for directional relationships
  ELEMENT_CONTEXT_RADIUS: 300, // Default radius for element context
};

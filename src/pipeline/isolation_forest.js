/**
 * isolation_forest.js — Pure-JS Fast Multivariate Isolation Forest
 * ─────────────────────────────────────────────────────────────
 * Implements the Isolation Forest algorithm (Liu, Ting, Zhou 2008)
 * for unsupervised multivariate anomaly detection across the 5 electrical features:
 * [ voltage_v, current_a, active_power_kw, power_factor, frequency_hz ]
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

class IsolationTreeNode {
  constructor(size) {
    this.size = size;
    this.isLeaf = true;
    this.splitFeature = null;
    this.splitValue = null;
    this.left = null;
    this.right = null;
  }
}

class IsolationForest {
  /**
   * @param {Object} options
   * @param {number} options.nTrees - Number of isolation trees (default: 50)
   * @param {number} options.subsampleSize - Subsampling size per tree (default: 128)
   * @param {number} options.threshold - Anomaly score threshold (default: 0.60)
   */
  constructor(options = {}) {
    this.nTrees = options.nTrees || 50;
    this.subsampleSize = options.subsampleSize || 128;
    this.threshold = options.threshold || 0.60;
    this.trees = [];
    this.featureNames = ['voltage_v', 'current_a', 'active_power_kw', 'power_factor', 'frequency_hz'];
  }

  /**
   * Euler-Mascheroni constant approximation for c(n) average path length.
   */
  static c(n) {
    if (n <= 1) return 1;
    if (n === 2) return 1;
    const eulerGamma = 0.5772156649;
    return 2 * (Math.log(n - 1) + eulerGamma) - (2 * (n - 1) / n);
  }

  /**
   * Train the forest on an array of 5D feature vectors or telemetry records.
   * @param {Array<Object|Array<number>>} data
   */
  fit(data) {
    if (!data || data.length === 0) return this;
    const matrix = data.map(d => this._extractVector(d));
    const maxDepth = Math.ceil(Math.log2(Math.max(this.subsampleSize, 2)));

    this.trees = [];
    for (let t = 0; t < this.nTrees; t++) {
      const sample = this._getRandomSubsample(matrix, this.subsampleSize);
      const root = this._buildTree(sample, 0, maxDepth);
      this.trees.push(root);
    }
    return this;
  }

  /**
   * Predict anomaly score and classification for a single telemetry record.
   * @param {Object|Array<number>} record
   * @returns {{ anomalyScore: number, isAnomaly: boolean, label: string }}
   */
  predict(record) {
    const vector = this._extractVector(record);
    if (this.trees.length === 0) {
      // Default to baseline nominal if unfitted
      return { anomalyScore: 0.35, isAnomaly: false, label: 'nominal' };
    }

    let totalPathLength = 0;
    for (const tree of this.trees) {
      totalPathLength += this._pathLength(vector, tree, 0);
    }

    const avgPathLength = totalPathLength / this.trees.length;
    const cn = IsolationForest.c(this.subsampleSize);
    // Anomaly score formula s(x, n) = 2^(-E(h(x)) / c(n))
    const anomalyScore = Math.pow(2, - (avgPathLength / cn));
    const isAnomaly = anomalyScore >= this.threshold;

    return {
      anomalyScore: Number(anomalyScore.toFixed(3)),
      isAnomaly,
      label: isAnomaly ? 'isolated_anomaly' : 'nominal_cluster',
      avgPathLength: Number(avgPathLength.toFixed(2)),
      threshold: this.threshold
    };
  }

  _extractVector(item) {
    if (Array.isArray(item)) return item;
    return [
      typeof item.voltage_v === 'number' ? item.voltage_v : parseFloat(item.voltage || 230),
      typeof item.current_a === 'number' ? item.current_a : parseFloat(item.current || 10),
      typeof item.active_power_kw === 'number' ? item.active_power_kw : parseFloat(item.power_kw || (item.power ? item.power / 1000 : 20)),
      typeof item.power_factor === 'number' ? item.power_factor : parseFloat(item.power_factor || 0.95),
      typeof item.frequency_hz === 'number' ? item.frequency_hz : parseFloat(item.frequency || 50)
    ];
  }

  _getRandomSubsample(matrix, size) {
    const n = matrix.length;
    const k = Math.min(size, n);
    const chosen = [];
    for (let i = 0; i < k; i++) {
      const idx = Math.floor(Math.random() * n);
      chosen.push(matrix[idx]);
    }
    return chosen;
  }

  _buildTree(X, currentDepth, maxDepth) {
    const nSamples = X.length;
    if (currentDepth >= maxDepth || nSamples <= 1) {
      return new IsolationTreeNode(nSamples);
    }

    const nFeatures = this.featureNames.length;
    const splitFeat = Math.floor(Math.random() * nFeatures);

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < nSamples; i++) {
      const v = X[i][splitFeat];
      if (v < min) min = v;
      if (v > max) max = v;
    }

    if (min === max) {
      return new IsolationTreeNode(nSamples);
    }

    const splitVal = min + Math.random() * (max - min);
    const leftX = [];
    const rightX = [];

    for (let i = 0; i < nSamples; i++) {
      if (X[i][splitFeat] < splitVal) {
        leftX.push(X[i]);
      } else {
        rightX.push(X[i]);
      }
    }

    const node = new IsolationTreeNode(nSamples);
    node.isLeaf = false;
    node.splitFeature = splitFeat;
    node.splitValue = splitVal;
    node.left = this._buildTree(leftX, currentDepth + 1, maxDepth);
    node.right = this._buildTree(rightX, currentDepth + 1, maxDepth);
    return node;
  }

  _pathLength(x, node, currentDepth) {
    if (node.isLeaf) {
      return currentDepth + IsolationForest.c(node.size);
    }
    if (x[node.splitFeature] < node.splitValue) {
      return this._pathLength(x, node.left, currentDepth + 1);
    } else {
      return this._pathLength(x, node.right, currentDepth + 1);
    }
  }
}

module.exports = IsolationForest;

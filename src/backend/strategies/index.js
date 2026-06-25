/**
 * @fileoverview 负载均衡策略模块
 *
 * 策略类型：
 * - least_busy: 按 worker 负载（activeCount + pendingCount）升序选择
 * - round_robin: 在可用 worker 中轮询
 * - random:     在可用 worker 中随机选择
 *
 * 跳过不可用 worker：
 *   - 不可用（isHealthy() = false）
 *   - 本地队列已满（isLocalQueueFull() = true）
 */

export const STRATEGIES = {
    LEAST_BUSY: 'least_busy',
    ROUND_ROBIN: 'round_robin',
    RANDOM: 'random'
};

function getLoad(worker) {
    if (typeof worker.load === 'number') return worker.load;
    // 兼容：仅 busyCount
    return worker.busyCount || 0;
}

export function createStrategySelector(strategy) {
    let roundRobinIndex = 0;

    function isSelectable(worker) {
        if (typeof worker.isHealthy === 'function' && !worker.isHealthy()) return false;
        if (typeof worker.isLocalQueueFull === 'function' && worker.isLocalQueueFull()) return false;
        return true;
    }

    return {
        /**
         * 根据策略排序候选列表（仅保留可用 worker）。
         */
        sort(candidates) {
            const filtered = candidates.filter(isSelectable);
            if (filtered.length === 0) return [];
            if (filtered.length === 1) return filtered;

            switch (strategy) {
                case STRATEGIES.ROUND_ROBIN: {
                    const start = roundRobinIndex % filtered.length;
                    roundRobinIndex++;
                    return [...filtered.slice(start), ...filtered.slice(0, start)];
                }
                case STRATEGIES.RANDOM: {
                    return [...filtered].sort(() => Math.random() - 0.5);
                }
                case STRATEGIES.LEAST_BUSY:
                default: {
                    return [...filtered].sort((a, b) => getLoad(a) - getLoad(b));
                }
            }
        },

        /**
         * 选择单个最优候选
         */
        select(candidates) {
            const sorted = this.sort(candidates);
            return sorted[0] || null;
        }
    };
}

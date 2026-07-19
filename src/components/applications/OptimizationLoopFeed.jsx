import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Zap,
  Clock,
  RefreshCw,
  Target,
  ChevronRight,
  GitBranch,
  History,
  AlertCircle,
} from 'lucide-react';
import { format } from 'date-fns';

const GATE_COLORS = {
  boarding: {
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    text: 'text-amber-800',
    label: 'boarding',
  },
  departure: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    text: 'text-emerald-800',
    label: 'departure',
  },
};

const PRIORITY_BORDERS = {
  critical: 'border-l-red-500',
  high: 'border-l-orange-400',
  medium: 'border-l-yellow-400',
};

function AdvisorSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading optimization advisor">
      <Skeleton className="h-32 w-full rounded-xl" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}

function GateBadge({ gate }) {
  const c = GATE_COLORS[gate] || GATE_COLORS.boarding;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${c.bg} ${c.border} ${c.text}`}
    >
      <Target className="w-2.5 h-2.5" />
      {c.label}
    </span>
  );
}

function RecommendationCard({ rec }) {
  const borderClass = PRIORITY_BORDERS[rec.priority] || 'border-l-slate-300';
  return (
    <div className={`border-l-4 ${borderClass} pl-3 py-2 rounded-r-lg bg-slate-50`}>
      <div className="flex items-start gap-2">
        <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold bg-slate-200 text-slate-700 mt-0.5">
          {rec.rank}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <Badge
              className={`text-[9px] px-1.5 py-0 ${
                rec.priority === 'critical'
                  ? 'bg-red-100 text-red-800 border-red-200'
                  : 'bg-orange-100 text-orange-800 border-orange-200'
              }`}
            >
              {rec.priority}
            </Badge>
            <span className="text-xs font-medium text-slate-800">{rec.title}</span>
          </div>
          {rec.estimatedGateImpact && (
            <p className="text-[10px] text-slate-500 mt-0.5">
              Gate impact:{' '}
              <span className="text-slate-600 font-mono">{rec.estimatedGateImpact}</span>
            </p>
          )}
          {rec.snapshotInputRef && (
            <p className="text-[9px] text-slate-400 font-mono mt-0.5 truncate">
              {rec.snapshotInputRef}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function AppOptimizationCard({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const hasRecs = entry.recommendations?.length > 0;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="bg-white/70 backdrop-blur-md border-white/20">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <GateBadge gate={entry.currentGate} />
                {entry.isStaleScore && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 font-medium">
                    <Clock className="w-2.5 h-2.5" />
                    Stale score
                  </span>
                )}
              </div>
              <p className="font-semibold text-sm text-slate-900 leading-tight truncate">
                {entry.jobTitle || 'Untitled role'}
              </p>
              <p className="text-xs text-slate-500">{entry.company}</p>
            </div>
            <div className="text-right flex-shrink-0">
              {entry.scoreSummary?.overallScore != null && (
                <p className="text-lg font-bold text-purple-600">
                  {Math.round(entry.scoreSummary.overallScore)}
                  <span className="text-xs text-slate-500 font-normal">%</span>
                </p>
              )}
              {entry.scoreSummary?.mustHaveScore != null && (
                <p className="text-[10px] text-slate-500">
                  MH: {Math.round(entry.scoreSummary.mustHaveScore)}%
                </p>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {!hasRecs ? (
            <p className="text-xs text-slate-500 italic">
              No recommendations — score data may be incomplete.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                {(expanded ? entry.recommendations : entry.recommendations.slice(0, 2)).map(
                  (rec, i) => (
                    <RecommendationCard key={i} rec={rec} />
                  )
                )}
              </div>
              {entry.recommendations.length > 2 && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="mt-2 text-[11px] flex items-center gap-1 text-purple-600 hover:text-purple-700 transition-colors"
                >
                  <ChevronRight
                    className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
                  />
                  {expanded ? 'Show less' : `+${entry.recommendations.length - 2} more`}
                </button>
              )}
            </>
          )}
          {entry.snapshotDate && (
            <p className="text-[9px] text-slate-400 mt-3">
              Snapshot: {format(new Date(entry.snapshotDate), 'MMM d, yyyy')}
              {entry.scoreSummary?.scoreVersion && ` · ${entry.scoreSummary.scoreVersion}`}
            </p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function LogHistory({ logs }) {
  if (!logs?.length) return null;

  return (
    <Card className="bg-white/70 backdrop-blur-md border-white/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-purple-600" />
          Recent Optimizations
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {logs.slice(0, 10).map((log) => (
            <div
              key={log.id ?? `${log.optimization_type}-${log.created_date}`}
              className="border-l-4 border-l-purple-500 pl-4 py-2"
            >
              <Badge className="mb-2">{log.optimization_type}</Badge>
              <p className="text-sm text-slate-700">{log.reason}</p>
              {log.success_impact != null && (
                <p className="text-xs text-green-600 mt-1">
                  Impact: +{log.success_impact}% success rate
                </p>
              )}
              {log.created_date && (
                <p className="text-[10px] text-slate-400 mt-1">
                  {format(new Date(log.created_date), 'MMM d, yyyy h:mm a')}
                </p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function OptimizationLoopFeed({
  advisorData,
  optimizationLogs = [],
  isLoading,
  isFetching,
  isError,
  error,
  onRefresh,
}) {
  const data = advisorData;
  const isEmpty =
    !data ||
    data.meta?.dataQuality === 'empty' ||
    ((data.applications?.length ?? 0) === 0 &&
      (data.crossApplicationPatterns?.length ?? 0) === 0);
  const hasPatterns = (data?.crossApplicationPatterns?.length ?? 0) > 0;
  const hasLogs = optimizationLogs.length > 0;
  const showEmptyState = !isLoading && !isError && isEmpty && !hasLogs;

  return (
    <div className="space-y-6">
      <Card className="bg-white/70 backdrop-blur-md border-white/20">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-blue-600" />
            Live Advisor Feed
            <Badge variant="outline" className="ml-1 text-xs font-normal">
              Read-only
            </Badge>
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isFetching}
            aria-label="Refresh optimization advisor"
          >
            <RefreshCw className={`h-4 w-4 mr-1.5 ${isFetching ? 'animate-spin' : ''}`} />
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        </CardHeader>

        <CardContent>
          {isLoading && <AdvisorSkeleton />}

          {isError && !isLoading && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Advisor unavailable</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <span>{error?.message ?? 'Could not load optimization advisor.'}</span>
                <Button variant="outline" size="sm" className="w-fit" onClick={onRefresh}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {showEmptyState && (
            <div className="py-10 text-center px-4">
              <p className="font-semibold text-slate-700 mb-1">No optimization data yet</p>
              <p className="text-sm text-slate-500 mb-2 max-w-sm mx-auto">
                Move applications on the Kanban board or score a resume against a JD to populate
                the loop.
              </p>
              <p className="text-xs text-slate-400">
                Track applications and run ATS scoring to unlock recommendations.
              </p>
            </div>
          )}

          {!isLoading && !isError && !isEmpty && (
            <AnimatePresence>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {data.applications.map((entry) => (
                  <AppOptimizationCard key={entry.applicationId} entry={entry} />
                ))}
              </div>
            </AnimatePresence>
          )}

          {!isLoading && !isError && hasPatterns && (
            <div className={isEmpty ? 'mt-0' : 'mt-6'}>
              <div className="flex items-center gap-2 mb-3">
                <GitBranch className="w-4 h-4 text-cyan-600" />
                <h3 className="text-sm font-semibold text-cyan-800">Cross-Application Patterns</h3>
              </div>
              <div className="space-y-2">
                {data.crossApplicationPatterns.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 p-3 rounded-lg bg-cyan-50 border border-cyan-100"
                  >
                    <Badge className="flex-shrink-0 bg-white text-slate-600 border-slate-200 text-[10px] mt-0.5">
                      {p.affectedCount} apps
                    </Badge>
                    <div>
                      <p className="text-xs font-medium text-slate-800">{p.pattern}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{p.recommendation}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!isLoading && isFetching && !isError && (
            <p className="text-xs text-slate-500 mt-4">Updating recommendations…</p>
          )}

          {!isLoading && (
            <p className="text-[10px] text-slate-400 text-center mt-4">
              Read-only advisor — no score or pipeline writes from this feed.
              {data?.meta?.generatedAt &&
                ` · Updated ${format(new Date(data.meta.generatedAt), 'h:mm a')}`}
            </p>
          )}
        </CardContent>
      </Card>

      {!isLoading && hasLogs && <LogHistory logs={optimizationLogs} />}
    </div>
  );
}

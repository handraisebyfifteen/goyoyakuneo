import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicOwner } from "@shared/schema";

export function useAuth() {
  const qc = useQueryClient();
  const q = useQuery<{ ok: boolean; owner: PublicOwner | null }>({ queryKey: ["/api/auth/me"], staleTime: 60_000 });
  return {
    owner: q.data?.owner ?? null,
    isLoading: q.isLoading,
    refresh: () => qc.invalidateQueries({ queryKey: ["/api/auth/me"] }),
  };
}

"use client";

/**
 * The operator console: seller accounts (live mode, headless, session check),
 * API keys for calling apps, and every listing with its status, error and
 * step screenshots.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type Account = RouterOutputs["lister"]["accounts"][number];
type Listing = RouterOutputs["lister"]["listings"][number];

export function ListerConsole() {
  const accounts = trpc.lister.accounts.useQuery();
  const keys = trpc.lister.apiClients.useQuery();
  const listings = trpc.lister.listings.useQuery(undefined, {
    refetchInterval: 4000,
  });

  const onError = (err: { message: string }) => toast.error(err.message);
  const updateAccount = trpc.lister.updateAccount.useMutation({
    onSuccess: () => void accounts.refetch(),
    onError,
  });
  const checkAccount = trpc.lister.checkAccount.useMutation({
    onSuccess: () => {
      toast.info("Session check queued");
      setTimeout(() => void accounts.refetch(), 15000);
    },
    onError,
  });
  const createAccount = trpc.lister.createAccount.useMutation({
    onSuccess: () => {
      void accounts.refetch();
      toast.success("Account added");
    },
    onError,
  });
  const createKey = trpc.lister.createApiClient.useMutation({
    onSuccess: (r) => {
      setNewKey(r.key);
      void keys.refetch();
    },
    onError,
  });
  const revokeKey = trpc.lister.revokeApiClient.useMutation({
    onSuccess: () => void keys.refetch(),
    onError,
  });
  const listingAction = trpc.lister.listingAction.useMutation({
    onSuccess: () => {
      toast.info("Queued");
      void listings.refetch();
    },
    onError,
  });

  const [keyName, setKeyName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [acct, setAcct] = useState({ label: "", externalAccountId: "" });

  const accountColumns: DataTableColumn<Account>[] = [
    {
      key: "label",
      header: "Account",
      cell: (a) => (
        <div>
          <div className="font-medium">{a.label}</div>
          <div className="text-xs text-muted-foreground">
            {a.platform} · {a.externalAccountId} · {a.id}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (a) => (
        <div className="space-y-1">
          <Badge variant={a.status === "READY" ? "default" : "secondary"}>
            {a.status}
          </Badge>
          {a.lastError && (
            <div className="max-w-xs whitespace-normal text-xs text-destructive">
              {a.lastError}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "mode",
      header: "Mode",
      cell: (a) => (
        <Badge
          data-testid={`mode-${a.id}`}
          variant={a.liveMode ? "destructive" : "outline"}
        >
          {a.liveMode ? "LIVE" : "dry run"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (a) => (
        <div className="flex flex-wrap justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => checkAccount.mutate({ accountId: a.id })}
          >
            Check session
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              updateAccount.mutate({ accountId: a.id, headless: !a.headless })
            }
          >
            {a.headless ? "Headless" : "Headed"}
          </Button>
          {a.liveMode ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                updateAccount.mutate({ accountId: a.id, liveMode: false })
              }
            >
              Back to dry run
            </Button>
          ) : (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="destructive">
                  Go live
                </Button>
              }
              title="Turn on live posting?"
              description="Listings for this account will really be published on the platform (the Publish button gets clicked)."
              confirmLabel="Go live"
              destructive
              onConfirm={() =>
                updateAccount.mutate({ accountId: a.id, liveMode: true })
              }
            />
          )}
        </div>
      ),
    },
  ];

  const listingColumns: DataTableColumn<Listing>[] = [
    {
      key: "title",
      header: "Listing",
      cell: (l) => (
        <div className="whitespace-normal">
          <div className="font-medium">{l.title}</div>
          <div className="text-xs text-muted-foreground">
            ${(l.priceCents / 100).toFixed(2)} · {l.accountLabel} ·{" "}
            {l.externalRef.system}/{l.externalRef.kind}/{l.externalRef.id}
          </div>
          {l.url && (
            <a
              className="text-xs underline"
              href={l.url}
              target="_blank"
              rel="noreferrer"
            >
              {l.platformListingId}
            </a>
          )}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (l) => (
        <div className="space-y-1">
          <Badge data-testid={`listing-status-${l.id}`}>{l.status}</Badge>
          {l.pendingAction && (
            <div className="text-xs text-muted-foreground">
              queued: {l.pendingAction}
            </div>
          )}
          {l.lastError && (
            <div className="max-w-xs whitespace-normal text-xs text-destructive">
              {l.lastError}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "shots",
      header: "Screenshots",
      cell: (l) => (
        <div className="flex max-w-xs flex-wrap gap-1">
          {l.screenshotKeys.map((k, i) => (
            <a
              key={k}
              href={`/api/media/blob?key=${encodeURIComponent(k)}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs underline"
              title={k.split("/").pop()}
            >
              {i + 1}
            </a>
          ))}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (l) => (
        <div className="flex justify-end gap-1">
          {l.status === "FAILED" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                listingAction.mutate({ listingId: l.id, action: "retry" })
              }
            >
              Retry
            </Button>
          )}
          {l.status !== "SOLD" && l.status !== "REMOVED" && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  listingAction.mutate({ listingId: l.id, action: "markSold" })
                }
              >
                Mark sold
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  listingAction.mutate({ listingId: l.id, action: "remove" })
                }
              >
                Remove
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Lister</h1>
        <p className="text-sm text-muted-foreground">
          Posts, marks sold and removes marketplace listings for the apps that
          call its API.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Seller accounts</h2>
          </CardTitle>
          <CardDescription>
            One logged-in browser profile per account. Dry run walks the whole
            form and stops before Publish.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {accounts.isPending ? (
            <LoadingState label="Loading accounts…" />
          ) : (accounts.data ?? []).length === 0 ? (
            <EmptyState title="No accounts" description="Add one below." />
          ) : (
            <DataTable
              caption="Seller accounts"
              columns={accountColumns}
              rows={accounts.data ?? []}
              rowKey={(a) => a.id}
            />
          )}
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createAccount.mutate({ platform: "FACEBOOK", ...acct });
              setAcct({ label: "", externalAccountId: "" });
            }}
          >
            <Input
              aria-label="Account label"
              placeholder="Label"
              className="w-48"
              value={acct.label}
              onChange={(e) => setAcct({ ...acct, label: e.target.value })}
            />
            <Input
              aria-label="Facebook user id"
              placeholder="Facebook user id"
              className="w-48"
              value={acct.externalAccountId}
              onChange={(e) =>
                setAcct({ ...acct, externalAccountId: e.target.value })
              }
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={!acct.label.trim() || !acct.externalAccountId.trim()}
            >
              Add Facebook account
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>API keys</h2>
          </CardTitle>
          <CardDescription>
            For apps that call lister (Authorization: Bearer). A key is shown
            once. Keys in LISTER_API_CLIENTS (.env) are not listed here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (keyName.trim()) createKey.mutate({ name: keyName.trim() });
              setKeyName("");
            }}
          >
            <Input
              aria-label="API key name"
              placeholder="Calling app name"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
            <Button type="submit" disabled={!keyName.trim()}>
              Create key
            </Button>
          </form>
          {newKey && (
            <div className="rounded-md border p-3 text-sm">
              Copy it now, it is not shown again:{" "}
              <code data-testid="new-api-key" className="break-all font-mono">
                {newKey}
              </code>
            </div>
          )}
          <ul className="space-y-1 text-sm">
            {keys.data?.map((k) => (
              <li key={k.id} className="flex items-center gap-2">
                <span className="font-mono">{k.keyPrefix}…</span>
                <span>{k.name}</span>
                {k.revokedAt ? (
                  <Badge variant="outline">revoked</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => revokeKey.mutate({ id: k.id })}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Listings</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {listings.isPending ? (
            <LoadingState label="Loading listings…" />
          ) : (listings.data ?? []).length === 0 ? (
            <EmptyState
              title="No listings yet"
              description="Calling apps create them through the API."
            />
          ) : (
            <DataTable
              caption="Listings"
              columns={listingColumns}
              rows={listings.data ?? []}
              rowKey={(l) => l.id}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import {
  deleteBookingDocumentAction,
  listBookingDocumentsAction,
  renameBookingDocumentAction,
  type BookingDocumentView,
} from "@/app/(dashboard)/reservations/document-actions";

// ============================================================
// מסמכים להזמנה — the documents block both booking MDs order (הקמת הזמנה
// §"שלב 4 — מסמכים" ש'28-33; עריכת הזמנה §3.4 ש'49-53), WIRED to real
// storage: rows in guesthub.booking_documents, files in the durable uploads
// store, serving through the authenticated /uploads/bookings route.
//
// bookingId === null → the create wizard: every pick uploads IMMEDIATELY
// (booking_id NULL, file under bookings/pending/); the panel collects the ids
// via onIdsChange and attaches them inside the creation transaction. A
// discarded wizard soft-deletes its orphans (the panel's discard path).
// bookingId set → the edit window: the stored documents load on mount, and
// upload / rename / delete act against the reservation instantly.
//
// Rename edits the BASE name only — the extension is enforced server-side.
// Delete is SOFT (deleted_at); nothing here ever removes a disk file.
// ============================================================

type DocRow = {
  id: string;
  /** display base name (editable inline); the extension is server-owned */
  base: string;
  ext: string;
  size: number;
  kind: "pdf" | "image";
  /** preview URL: an object URL for fresh picks, the authenticated /uploads URL for stored rows */
  url: string;
  /** object URLs are client memory and must be revoked */
  isObjectUrl: boolean;
};

const ACCEPT = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function viewToRow(v: BookingDocumentView): DocRow {
  const { base, ext } = splitName(v.fileName);
  return {
    id: v.id,
    base,
    ext,
    size: v.sizeBytes,
    kind: v.kind,
    url: v.url ?? "",
    isObjectUrl: false,
  };
}

export function BookingDocuments({
  bookingId = null,
  onIdsChange,
}: {
  /** the reservation the documents belong to; null in the create wizard (pre-create uploads) */
  bookingId?: string | null;
  /** reports the CURRENT document ids — the wizard's attach + discard bookkeeping */
  onIdsChange?: (ids: string[]) => void;
}) {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const docsRef = useRef<DocRow[]>([]);
  docsRef.current = docs;

  // object URLs are client memory — release them when the block unmounts
  useEffect(() => {
    return () => {
      for (const d of docsRef.current) if (d.isObjectUrl) URL.revokeObjectURL(d.url);
    };
  }, []);

  // the edit window opens on a reservation that may already carry documents
  useEffect(() => {
    if (!bookingId) return;
    let alive = true;
    void listBookingDocumentsAction(bookingId).then((res) => {
      if (!alive) return;
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      setDocs((res.data ?? []).map(viewToRow));
    });
    return () => {
      alive = false;
    };
  }, [bookingId]);

  useEffect(() => {
    onIdsChange?.(docs.map((d) => d.id));
  }, [docs, onIdsChange]);

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || uploading) return;
    const picked = Array.from(files);
    setUploading(true);
    void (async () => {
      try {
        for (const f of picked) {
          const isPdf = f.type === "application/pdf";
          const isImg = f.type === "image/jpeg" || f.type === "image/png";
          if (!isPdf && !isImg) continue; // JPG/PNG/PDF only (MD)
          const fd = new FormData();
          fd.append("file", f);
          if (bookingId) fd.append("bookingId", bookingId);
          const resp = await fetch("/api/reservations/documents", { method: "POST", body: fd });
          const json = (await resp.json().catch(() => null)) as
            | { document?: { id: string; file_name: string; mime_type: string; size_bytes: number }; error?: string }
            | null;
          if (!resp.ok || !json?.document) {
            toast.error(json?.error ?? "העלאת המסמך נכשלה");
            continue;
          }
          const { base, ext } = splitName(json.document.file_name);
          const row: DocRow = {
            id: json.document.id,
            base,
            ext,
            size: json.document.size_bytes,
            kind: isPdf ? "pdf" : "image",
            // the freshly-picked file previews from client memory — no round-trip
            url: URL.createObjectURL(f),
            isObjectUrl: true,
          };
          setDocs((all) => [...all, row]);
        }
      } finally {
        setUploading(false);
      }
    })();
  };

  const remove = (id: string) => {
    void deleteBookingDocumentAction(id).then((res) => {
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      const doc = docsRef.current.find((d) => d.id === id);
      if (doc?.isObjectUrl) URL.revokeObjectURL(doc.url);
      setDocs((all) => all.filter((d) => d.id !== id));
      setViewId((v) => (v === id ? null : v));
    });
  };

  const rename = (id: string, base: string) => {
    setRenamingId(null);
    const clean = base.trim();
    const current = docsRef.current.find((d) => d.id === id);
    if (!clean || !current || clean === current.base) return;
    void renameBookingDocumentAction({ docId: id, base: clean }).then((res) => {
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      // the server owns the final name (extension enforced there)
      const next = splitName(res.data?.fileName ?? `${clean}${current.ext}`);
      setDocs((all) => all.map((d) => (d.id === id ? { ...d, base: next.base, ext: next.ext } : d)));
    });
  };

  const viewed = viewId ? docs.find((d) => d.id === viewId) : null;

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div
        role="button"
        tabIndex={0}
        aria-busy={uploading}
        className={`bw-drop${drag ? " drag" : ""}`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <Icon name="upload" size={36} />
        <span className="bw-drop-main">
          {uploading ? "מעלה…" : "גררו לכאן מסמכים או לחצו לבחירה"}
        </span>
        <span className="bw-drop-sub">
          תמונות (JPG/PNG) או PDF · המסמכים נשמרים תמיד יחד עם ההזמנה
        </span>
      </div>

      {docs.length > 0 && (
        <ul className="bw-doc-list">
          {docs.map((d) => (
            <li key={d.id} className="bw-doc">
              <span className={`bw-doc-ic ${d.kind === "pdf" ? "pdf" : "img"}`}>
                <Icon name={d.kind === "pdf" ? "pdf" : "image"} size={26} />
              </span>
              <div className="bw-doc-txt">
                {renamingId === d.id ? (
                  <input
                    className="bw-doc-name-input"
                    autoFocus
                    defaultValue={d.base}
                    aria-label="שינוי שם קובץ"
                    onBlur={(e) => rename(d.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        rename(d.id, e.currentTarget.value);
                      } else if (e.key === "Escape") {
                        setRenamingId(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="bw-doc-name"
                    title="צפייה במסמך"
                    onClick={() => setViewId(d.id)}
                  >
                    {d.base}
                  </button>
                )}
                <span className="bw-doc-size">
                  <bdi className="ltr-num">{fmtSize(d.size)}</bdi> · שמור בהזמנה
                </span>
              </div>
              <span className="bw-doc-acts">
                <button
                  type="button"
                  className="bw-doc-act"
                  title="שינוי שם"
                  aria-label="שינוי שם"
                  onClick={() => setRenamingId(d.id)}
                >
                  <Icon name="edit" size={20} />
                </button>
                <button
                  type="button"
                  className="bw-doc-act"
                  title="צפייה"
                  aria-label="צפייה"
                  onClick={() => setViewId(d.id)}
                >
                  <Icon name="eye" size={20} />
                </button>
                <button
                  type="button"
                  className="bw-doc-act del"
                  title="הסרה"
                  aria-label="הסרה"
                  onClick={() => remove(d.id)}
                >
                  <Icon name="trash" size={20} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* internal viewer — a centered view-only modal (the MD's explicit
          order for this block); no download affordance is rendered */}
      {viewed && viewed.url && (
        <div className="bw-docv" role="dialog" aria-label={`צפייה: ${viewed.base}`}>
          <div className="bw-docv-box">
            <div className="bw-docv-hd">
              <Icon name={viewed.kind === "pdf" ? "pdf" : "image"} size={20} />
              <span className="min-w-0 flex-1 truncate">{viewed.base}</span>
              <button
                type="button"
                className="dw-close"
                title="סגירה"
                onClick={() => setViewId(null)}
              >
                <Icon name="close" size={20} label="סגירה" />
              </button>
            </div>
            <div className="bw-docv-bd">
              {viewed.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={viewed.url} alt={viewed.base} />
              ) : (
                <iframe src={`${viewed.url}#toolbar=0`} title={viewed.base} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

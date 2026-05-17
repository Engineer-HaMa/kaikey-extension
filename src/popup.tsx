import { useStorage } from "@plasmohq/storage/hook"
import {
  ArrowLeft,
  Download,
  LogOut,
  QrCode,
  Share2,
  ShieldCheck,
  Upload
} from "lucide-react"
import qrcode from "qrcode-generator"
import { useRef, useState } from "react"

import { Button } from "~components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~components/ui/card"
import { Switch } from "~components/ui/switch"
import type { DeviceState } from "~lib/auth"
import { decryptState, encryptState } from "~lib/share"
import { AUTO_LOGIN_KEY, STATE_KEY, loadState, storage } from "~lib/state"
import { sendBg } from "~popup/messaging"
import { decodeQrFromFile } from "~popup/qr"

import "./style.css"

const REGISTER_URL =
  "https://sso.kaist.ac.kr/auth/twofactor/mfa/regist/step01"

// Firefox closes the toolbar popup the moment an OS file dialog opens
// (bug 1292701). To keep the same UI in Firefox we open a windows.create
// popup for the upload step. Chrome is unaffected so it keeps the
// original in-popup file picker behavior.
const IS_FIREFOX = process.env.PLASMO_BROWSER === "firefox"

const WINDOW_MODE =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("mode") === "window"

const NEED_UPLOAD_WINDOW = IS_FIREFOX && !WINDOW_MODE

const UPLOAD_WINDOW_URL =
  chrome.runtime.getURL("popup.html") + "?mode=window"

type AuthCheckResult = {
  pending: boolean
  idToken?: string
  choices?: string[]
  realNumber?: string
  errcode?: string
}

type View = "default" | "export" | "import"

function IndexPopup() {
  const [state] = useStorage<DeviceState>({ key: STATE_KEY, instance: storage })
  const [autoLogin, setAutoLogin] = useStorage<boolean>(
    { key: AUTO_LOGIN_KEY, instance: storage },
    (v) => (v === undefined ? true : v)
  )
  const [view, setView] = useState<View>("default")

  const hasSite = !!state?.sites?.length
  const back = () => setView("default")

  let body: JSX.Element
  if (view === "export") {
    body = <ExportView onBack={back} />
  } else if (view === "import") {
    body = <ImportView onBack={back} onSuccess={back} />
  } else if (hasSite) {
    body = (
      <RegisteredView
        state={state!}
        autoLogin={!!autoLogin}
        setAutoLogin={setAutoLogin}
        onExport={() => setView("export")}
      />
    )
  } else {
    body = <SetupView onImport={() => setView("import")} />
  }

  return (
    <div className="p-4 space-y-3 text-foreground">
      <header className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h1 className="text-base font-semibold">Kaikey</h1>
      </header>
      {body}
    </div>
  )
}

function SetupView({ onImport }: { onImport: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const openRegistrationPage = () => {
    chrome.tabs.create({ url: REGISTER_URL })
  }

  const openUploadWindow = () => {
    chrome.windows.create({
      url: UPLOAD_WINDOW_URL,
      type: "popup",
      width: 380,
      height: 360
    })
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setError(null)
    setSuccess(null)
    setBusy(true)
    try {
      const qrJson = await decodeQrFromFile(file)
      const reply = await sendBg<{ site_id: string; display_nm: string }>({
        type: "register",
        qrJson
      })
      if (!reply.ok) throw new Error(reply.error)
      if (WINDOW_MODE) {
        window.close()
        return
      }
      setSuccess(
        `Registered ${reply.data.display_nm} (${reply.data.site_id}).`
      )
    } catch (err) {
      setError((err as Error).message || String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
          <li>Open the registration page and complete registration.</li>
          <li>
            A QR code will be shown at the end. Take a screenshot of it.
          </li>
          <li>Upload the screenshot below.</li>
        </ol>
        <Button className="w-full" onClick={openRegistrationPage}>
          <QrCode className="h-4 w-4" /> Open registration page
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFile}
        />
        <Button
          className="w-full"
          variant="outline"
          disabled={busy}
          onClick={
            NEED_UPLOAD_WINDOW
              ? openUploadWindow
              : () => fileRef.current?.click()
          }>
          <Upload className="h-4 w-4" />
          {busy ? "Registering…" : "Upload QR screenshot"}
        </Button>
        {error && (
          <p className="text-xs text-destructive break-words">{error}</p>
        )}
        {success && <p className="text-xs text-emerald-600">{success}</p>}
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-muted-foreground"
          onClick={onImport}>
          <Download className="h-4 w-4" /> Import from another device
        </Button>
      </CardContent>
    </Card>
  )
}

function RegisteredView({
  state,
  autoLogin,
  setAutoLogin,
  onExport
}: {
  state: DeviceState
  autoLogin: boolean
  setAutoLogin: (v: boolean) => void
  onExport: () => void
}) {
  const site = state.sites[0]
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<AuthCheckResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const checkRequests = async () => {
    setBusy(true)
    setError(null)
    setMessage(null)
    setPending(null)
    try {
      const reply = await sendBg<AuthCheckResult>({ type: "auth-check" })
      if (!reply.ok) throw new Error(reply.error)
      if (!reply.data.pending) {
        setMessage("No pending request.")
      } else {
        setPending(reply.data)
      }
    } catch (e) {
      setError((e as Error).message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const pickNumber = async (n: string) => {
    if (!pending?.idToken || !pending?.realNumber) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const reply = await sendBg({
        type: "approve",
        idToken: pending.idToken,
        selectedNumber: n,
        realNumber: pending.realNumber
      })
      if (!reply.ok) throw new Error(reply.error)
      setMessage("Approved.")
      setPending(null)
    } catch (e) {
      setError((e as Error).message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const [confirmingLogout, setConfirmingLogout] = useState(false)
  const logout = async () => {
    if (!confirmingLogout) {
      setConfirmingLogout(true)
      setTimeout(() => setConfirmingLogout(false), 4000)
      return
    }
    setConfirmingLogout(false)
    setBusy(true)
    try {
      const reply = await sendBg({ type: "logout" })
      if (!reply.ok) throw new Error(reply.error)
      setMessage(null)
      setError(null)
      setPending(null)
    } catch (e) {
      setError((e as Error).message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="pt-4 space-y-1 text-sm">
          <div>
            <span className="text-muted-foreground">User:</span>{" "}
            <span className="font-medium">{site.display_nm}</span>
          </div>
          <div className="text-xs text-muted-foreground break-all">
            {site.site_id}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">Auto-login</div>
            <div className="text-xs text-muted-foreground">
              Auto-pick the matching number on the 2FA page.
            </div>
          </div>
          <Switch checked={autoLogin} onCheckedChange={setAutoLogin} />
        </CardContent>
      </Card>

      <Button className="w-full" disabled={busy} onClick={checkRequests}>
        {busy ? "Checking…" : "Check for login requests"}
      </Button>

      {pending && pending.choices && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Pick the number shown on the website
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-2">
            {pending.choices.map((n) => (
              <Button
                key={n}
                variant="outline"
                className="text-lg font-semibold h-12"
                disabled={busy}
                onClick={() => pickNumber(n)}>
                {n}
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      {message && <p className="text-xs text-emerald-600">{message}</p>}
      {error && (
        <p className="text-xs text-destructive break-words">{error}</p>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="w-full text-muted-foreground"
        disabled={busy}
        onClick={onExport}>
        <Share2 className="h-4 w-4" /> Export to another device
      </Button>

      <Button
        variant={confirmingLogout ? "destructive" : "ghost"}
        size="sm"
        className={
          confirmingLogout
            ? "w-full"
            : "w-full text-muted-foreground"
        }
        disabled={busy}
        onClick={logout}>
        <LogOut className="h-4 w-4" />
        {confirmingLogout ? "Click again to confirm" : "Logout"}
      </Button>
    </div>
  )
}

function ExportView({ onBack }: { onBack: () => void }) {
  const [passphrase, setPassphrase] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blob, setBlob] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const generate = async () => {
    setError(null)
    if (passphrase.length < 6) {
      setError("Passphrase must be at least 6 characters.")
      return
    }
    if (passphrase !== confirm) {
      setError("Passphrases do not match.")
      return
    }
    setBusy(true)
    try {
      const state = await loadState()
      if (!state.sites?.length) {
        setError("Nothing to export — no device registered.")
        return
      }
      const encoded = await encryptState(state, passphrase)
      const qr = qrcode(0, "L")
      qr.addData(encoded)
      qr.make()
      setQrDataUrl(qr.createDataURL(4, 2))
      setBlob(encoded)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copyBlob = async () => {
    if (!blob) return
    try {
      await navigator.clipboard.writeText(blob)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError("Could not copy to clipboard.")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Export device</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!blob ? (
          <>
            <p className="text-xs text-muted-foreground">
              Set a one-time passphrase. Enter the same on the receiving
              device.
            </p>
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Passphrase (min 6 chars)"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2"
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm passphrase"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") generate()
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2"
            />
            <Button className="w-full" onClick={generate} disabled={busy}>
              <QrCode className="h-4 w-4" />
              {busy ? "Encrypting…" : "Generate"}
            </Button>
          </>
        ) : (
          <>
            <img
              src={qrDataUrl!}
              alt="Share QR"
              className="mx-auto block bg-white p-1 rounded"
              style={{
                width: 200,
                height: 200,
                imageRendering: "pixelated"
              }}
            />
            <p className="text-[11px] text-muted-foreground text-center">
              Scan with your phone's camera, or copy the text below.
            </p>
            <textarea
              readOnly
              className="w-full h-16 rounded-md border border-input bg-background p-2 font-mono text-[9px] break-all"
              value={blob}
            />
            <Button
              className="w-full"
              variant="outline"
              onClick={copyBlob}>
              {copied ? "Copied." : "Copy text"}
            </Button>
            <p className="text-[10px] text-muted-foreground">
              Enter the same passphrase on the receiving device to decrypt.
            </p>
          </>
        )}
        {error && (
          <p className="text-xs text-destructive break-words">{error}</p>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-muted-foreground"
          onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      </CardContent>
    </Card>
  )
}

function ImportView({
  onBack,
  onSuccess
}: {
  onBack: () => void
  onSuccess: () => void
}) {
  const [blob, setBlob] = useState("")
  const [passphrase, setPassphrase] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const performImport = async () => {
    setError(null)
    const trimmed = blob.trim()
    if (!trimmed) {
      setError("Paste the encoded text from the source device.")
      return
    }
    if (!passphrase) {
      setError("Enter the passphrase from the source device.")
      return
    }
    setBusy(true)
    try {
      const state = await decryptState<DeviceState>(trimmed, passphrase)
      if (
        !state ||
        typeof state !== "object" ||
        !Array.isArray((state as DeviceState).sites)
      ) {
        throw new Error("Decrypted payload is not a Kaikey device state.")
      }
      await storage.set(STATE_KEY, state)
      onSuccess()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Import device</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Paste the encoded text from the source device and enter its
          passphrase.
        </p>
        <textarea
          placeholder="Paste the encoded text here…"
          className="w-full h-24 rounded-md border border-input bg-background p-2 font-mono text-[10px]"
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
        />
        <input
          type="password"
          autoComplete="off"
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") performImport()
          }}
          className="w-full rounded-md border border-input bg-background px-3 py-2"
        />
        <Button className="w-full" onClick={performImport} disabled={busy}>
          <Download className="h-4 w-4" />
          {busy ? "Decrypting…" : "Import"}
        </Button>
        {error && (
          <p className="text-xs text-destructive break-words">{error}</p>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-muted-foreground"
          onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      </CardContent>
    </Card>
  )
}

export default IndexPopup

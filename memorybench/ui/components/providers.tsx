"use client"

import { useRouter } from "next/navigation"
import { DownloadToast } from "./download-toast"

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter()

  const handleDownloadComplete = () => {
    // Refresh the current page when download completes
    router.refresh()
  }

  return (
    <>
      {children}
      <DownloadToast onDownloadComplete={handleDownloadComplete} />
    </>
  )
}

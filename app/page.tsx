import { redirect } from "next/navigation";

// The QR code points to /customer. Anyone opening the bare domain goes there too.
export default function Home() {
  redirect("/customer");
}

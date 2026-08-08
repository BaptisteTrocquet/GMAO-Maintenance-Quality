import { redirect } from "next/navigation";

export default function LegacyWorkOrderBoardPage() {
  redirect("/maintenance/kanban");
}

import { headers } from "next/headers";

export default async function AdminMembersPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";

  return (
    <main>
      <h1>Users & roles</h1>
      <p>Manage organization members, access level, and account availability.</p>
      {!organizationId ? (
        <p>Select an organization to manage its members.</p>
      ) : (
        <section>
          <p>Organization: {organizationId}</p>
          <p>The administration API is available at /api/admin/members.</p>
        </section>
      )}
    </main>
  );
}

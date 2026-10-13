export class ConnectPage {
  constructor(page) {
    this.page = page;
  }

  async open() {
    await this.page.goto('/connect');
    await this.page.getByRole('heading', { name: 'MCP', exact: true }).waitFor();
  }

  async addKey({ name, scope = 'read-write', expiry = '30d' }) {
    await this.page.getByLabel('Name for new key').fill(name);
    await this.page.getByLabel('Scope').selectOption(scope);
    await this.page.getByLabel('Expiry').selectOption(expiry);
    const response = this.page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/account/mcp' && res.request().method() === 'POST',
    );
    await this.page.getByRole('button', { name: 'Add key' }).click();
    const result = await response;
    if (result.status() !== 200) throw new Error(`Add key returned HTTP ${result.status()}`);
    return result.json();
  }

  keyRow(name) {
    return this.page.getByRole('row').filter({ hasText: name });
  }

  async removeKeys(prefix) {
    const response = await this.page.request.get('/api/account/mcp');
    if (response.status() !== 200) return;
    const { keys = [] } = await response.json();
    for (const key of keys.filter((item) => String(item.name || '').startsWith(prefix))) {
      await this.page.request.delete(`/api/account/mcp?id=${encodeURIComponent(key.id)}`).catch(() => {});
    }
  }
}

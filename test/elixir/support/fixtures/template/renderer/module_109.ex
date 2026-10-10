defmodule Hologram.Test.Fixtures.Template.Renderer.Module109 do
  use Hologram.Page

  route "/hologram-test-fixtures-template-renderer-module109"

  layout Hologram.Test.Fixtures.LayoutFixture

  @impl Page
  def init(_params, component, _server) do
    put_state(component, date: ~D[2026-10-05], nested: %{times: [~T[12:34:56]]})
  end

  @impl Page
  def template do
    ~HOLO""
  end
end

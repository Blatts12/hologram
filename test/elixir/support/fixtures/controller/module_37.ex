defmodule Hologram.Test.Fixtures.Controller.Module37 do
  use Hologram.Page

  route "/hologram-test-fixtures-controller-module37"

  layout Hologram.Test.Fixtures.LayoutWithRuntime

  @impl Page
  def template do
    ~HOLO""
  end
end

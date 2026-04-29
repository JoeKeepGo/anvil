import { BrowserRouter, Routes, Route } from "react-router-dom"
import { Layout } from "@/components/layout/Layout"
import { Dashboard } from "@/pages/Dashboard"
import { Instances } from "@/pages/Instances"
import { InstanceDetail } from "@/pages/InstanceDetail"
import { Images } from "@/pages/Images"
import { Operations } from "@/pages/Operations"
import { Settings } from "@/pages/Settings"

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="/instances" element={<Instances />} />
          <Route path="/instances/:name" element={<InstanceDetail />} />
          <Route path="/images" element={<Images />} />
          <Route path="/operations" element={<Operations />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

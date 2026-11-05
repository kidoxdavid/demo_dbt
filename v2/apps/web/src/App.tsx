import { Route, Routes } from 'react-router-dom';
import { BuyerHome } from './screens/BuyerHome';
import { DesignPage } from './design/DesignPage';
export default function App() {
  return <Routes><Route path="/" element={<BuyerHome />} /><Route path="/_design" element={<DesignPage />} /><Route path="*" element={<main className="pad" style={{ paddingTop: 40 }}><h1 className="serif">Not built yet</h1></main>} /></Routes>;
}

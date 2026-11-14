import { Navigate, useParams } from 'react-router-dom';

export default function Models() {
  const { providerId } = useParams();
  const target = providerId ? `/providers?open=${encodeURIComponent(providerId)}` : '/providers';
  return <Navigate to={target} replace />;
}
